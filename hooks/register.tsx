import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DocPage, FileDoc, GitMark, NavFile, NavOp, NavProps, NavRow, RepoIndex, RepoView, TreeRow } from '../types'
import {
  IGNORED_DIRS,
  MAX_FILES,
  docFromStat,
  docFromText,
  emptyDoc,
  errText,
  filterRows,
  pageOf,
  parentDirs,
  parseDiff,
  parseGitStatus,
  parseLsFiles,
  toRepoPath,
  treeRows,
} from './repo'
import { Tree, treeChromeRows } from './tree'
import { FILE_CHROME_ROWS, Viewer } from './viewer'

const PANE = 'repoviewer'
const TOOL = 'mcp__kesav__show_file'
/** `/files` is the name the CLI's feature request asked for; `/repo` the short one; `/repoviewer` its own. */
const COMMANDS = ['files', 'repo', 'repoviewer'] as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/** How often the pane notices changes made outside Claude (another editor, a git checkout). */
const POLL_MS = 8000
/** A file at most this long goes to the pane's Client whole, and can be edited there. */
const NAV_MAX_TEXT = 90000
/** Characters of tree rows handed to the Client (its props are bounded at 100,000). */
const NAV_ROW_BUDGET = 60000
/** Rows the hooks-drawn chrome takes above the Client: treeChromeRows (header, counts, finder, toolbar) and
 * FILE_CHROME_ROWS (viewer header, breadcrumb, toolbar), each drawn beside its own layout in tree.tsx and viewer.tsx. */
const FILE_CHROME = FILE_CHROME_ROWS

const DEFAULT_VIEW: RepoView = {
  mode: 'tree',
  expanded: [],
  cursor: '',
  filter: '',
  page: 0,
  isRaw: false,
  showDiff: false,
  follow: true,
  cursorAt: 0,
  lineAt: 0,
}

const index = atom({ plugin: 'kesav', key: 'index' } as const, null)
const git = atom({ plugin: 'kesav', key: 'git' } as const, {})
const touched = atom({ plugin: 'kesav', key: 'touched' } as const, {})
const view = atom({ plugin: 'kesav', key: 'view' } as const, DEFAULT_VIEW)
const revision = atom({ plugin: 'kesav', key: 'revision' } as const, 0)

type Engine = EngineInterface

function setView($: Engine, change: (v: RepoView) => RepoView) {
  return update($, view, change)
}

/** Choices kept across sessions in $.store: whether the pane was left open, and whether it follows
 * Claude's edits. (Not userConfig: any option there makes every install print "not yet set".) */
const OPEN_KEY = 'open'
const FOLLOW_KEY = 'follow'

/** The person closed the pane: it stays closed in the sessions after this one too, until /files. */
async function closeByUser($: Engine) {
  await $.ui.close({ id: PANE })
  await $.store.set(OPEN_KEY, false)
}

/** The toolbar's follow toggle, kept for the sessions after this one too. */
async function toggleFollow($: Engine) {
  await setView($, v => ({ ...v, follow: !v.follow }))
  await $.store.set(FOLLOW_KEY, (await read($, view)).follow)
}

/** The terminal's width as last measured, and the width it was when the dock was last sized. */
let termColumns = 0
let sizedFor = 0
/** How many times the pane has drawn: leavePane waits on it to see the reopened pane drawn. */
let draws = 0
const WIDTH_PERCENT = 40

/** The dock width to ask for: 40% of the terminal, at least 44 columns so code stays readable, at
 * most 100 so a wide screen keeps its transcript, and never leaving Claude under 70 columns. Below
 * that (a terminal of about 115 columns or less) it asks for nothing and the engine's share stands. */
function paneWidth(): number | undefined {
  if (termColumns <= 0) return undefined
  const want = Math.min(100, Math.max(44, Math.round((termColumns * WIDTH_PERCENT) / 100)), termColumns - 70)
  return want >= 44 ? want : undefined
}

/** Opens (or retitles and resizes) the pane, floor to ceiling on the right when docked. */
async function openPane($: Engine, focus = false) {
  const repo = await read($, index)
  const columns = paneWidth()
  if (columns !== undefined) sizedFor = termColumns
  return $.ui.open({
    id: PANE,
    title: repo ? baseName(repo.root) : 'Repo',
    ...(columns !== undefined ? { columns } : {}),
    ...(focus ? { focus: true as const } : {}),
  })
}

async function notify($: Engine, text: string, tone: 'info' | 'warn' | 'error') {
  const at = await $.clock.now().catch(() => 0)
  await setView($, v => ({ ...v, notice: { text, tone, at } }))
}

// ---------------------------------------------------------------------------
// Host I/O. The engine follows `$` only into functions of this file, so every
// command and read happens here and repo.ts parses what comes back.

async function loadIndex($: Engine): Promise<RepoIndex> {
  const cwd = await $.session.cwd().catch(() => '')
  const loadedAt = await $.clock.now().catch(() => 0)
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 20000 }).catch(() => undefined)
  const root = top?.exitCode === 0 ? top.stdout.trim() : ''
  if (root !== '') {
    const [ls, sym, sha] = await Promise.all([
      $.process.run(['git', '--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, timeoutMs: 30000 }).catch(() => undefined),
      $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, timeoutMs: 20000 }).catch(() => undefined),
      $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root, timeoutMs: 20000 }).catch(() => undefined),
    ])
    const branch = sym?.exitCode === 0 && sym.stdout.trim() ? sym.stdout.trim() : sha?.exitCode === 0 ? sha.stdout.trim() || undefined : undefined
    if (ls?.exitCode === 0) return { root, isGit: true, branch, ...parseLsFiles(ls.stdout, ls.isStdoutTruncated), loadedAt }
    return { root, isGit: true, branch, ...(await walk($, root)), loadedAt }
  }
  return { root: cwd, isGit: false, ...(await walk($, cwd)), loadedAt }
}

/** The file list of a folder that is not a git repo: breadth first, skipping IGNORED_DIRS and links. */
async function walk($: Engine, root: string): Promise<{ files: string[]; isTruncated: boolean }> {
  const files: string[] = []
  let queue = ['']
  while (queue.length > 0 && files.length < MAX_FILES) {
    const batch = queue.slice(0, 16)
    queue = queue.slice(16)
    const listed = await Promise.all(
      batch.map(async dir => ({ dir, entries: await $.fs.list(dir === '' ? root : `${root}/${dir}`).catch(() => []) })),
    )
    for (const { dir, entries } of listed) {
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
        if (entry.kind === 'dir') queue.push(rel)
        else if (entry.kind === 'file' && files.length < MAX_FILES) files.push(rel)
      }
    }
  }
  return { files: files.sort(), isTruncated: queue.length > 0 || files.length >= MAX_FILES }
}

async function loadGitStatus($: Engine, root: string): Promise<Record<string, GitMark>> {
  if (root === '') return {}
  const status = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, timeoutMs: 30000 }).catch(() => undefined)
  return status?.exitCode === 0 ? parseGitStatus(status.stdout, status.isStdoutTruncated) : {}
}

async function loadDoc($: Engine, root: string, path: string): Promise<FileDoc> {
  const abs = `${root}/${path}`
  let stat
  try {
    stat = await $.fs.stat(abs)
  } catch (error) {
    return emptyDoc(path, 'missing', { error: errText(error, 'file not found') })
  }
  const decided = docFromStat(root, path, stat)
  if (decided) return decided
  try {
    return docFromText(path, stat, await $.fs.read(abs))
  } catch (error) {
    return emptyDoc(path, 'missing', { size: stat.size, mtimeMs: stat.mtimeMs, error: errText(error, 'could not read file') })
  }
}

async function loadDiff($: Engine, root: string, path: string) {
  let diff = await $.process
    .run(['git', '--no-optional-locks', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--', path], { cwd: root, timeoutMs: 20000 })
    .catch(() => undefined)
  // A repo with no commit yet has no HEAD to diff against.
  if (diff?.exitCode !== 0) {
    diff = await $.process
      .run(['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', path], { cwd: root, timeoutMs: 20000 })
      .catch(() => undefined)
  }
  return diff?.exitCode === 0 ? parseDiff(diff.stdout, diff.isStdoutTruncated) : undefined
}

const isSameMarks = (a: Record<string, GitMark>, b: Record<string, GitMark>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

async function refreshGit($: Engine) {
  const repo = await read($, index)
  if (!repo) return
  const marks = await loadGitStatus($, repo.root)
  // Writing only on change keeps the pane from redrawing every poll.
  if (!isSameMarks(marks, await read($, git))) await update($, git, () => marks)
}

async function refreshAll($: Engine) {
  const repo = await loadIndex($)
  await update($, index, () => repo)
  await refreshGit($)
  await update($, revision, n => n + 1)
}

/** /clear, /resume and /branch reset every $.state value and fire no session.start: when the file
 * list is gone, read it again (once at a time). The pane's drawing and its poll both ask. */
let isLoading = false
async function loadIfMissing($: Engine) {
  if (isLoading || (await read($, index))) return
  isLoading = true
  try {
    await refreshAll($)
  } finally {
    isLoading = false
  }
}

/** The page of a doc that holds a 1-based line. */
function pageForLine(doc: Parameters<typeof pageOf>[0], line: number): number {
  const first = pageOf(doc, 0)
  for (let page = first.pageCount - 1; page > 0; page -= 1) {
    if (pageOf(doc, page).startLine <= line) return page
  }
  return 0
}

/** Shows a file in the viewer: opens the pane, and reveals the file's folder in the tree. */
async function showFile($: Engine, path: string, line?: number) {
  const repo = await read($, index)
  let page = 0
  if (repo && line !== undefined) {
    const doc = await loadDoc($, repo.root, path)
    page = pageForLine(doc, line)
  }
  await setView($, v => ({
    ...v,
    mode: 'file',
    openPath: path,
    cursor: path,
    cursorAt: v.cursorAt + 1,
    page,
    showDiff: false,
    editing: v.editing === path ? v.editing : undefined,
    // A line only comes with show_file; a file opened any other way starts at its top.
    ...(line !== undefined ? { line, lineAt: v.lineAt + 1 } : { line: undefined }),
    expanded: [...new Set([...v.expanded, ...parentDirs(path)])],
  }))
  await openPane($)
}

const collapsed = (expanded: string[], dir: string) =>
  expanded.filter(open => open !== dir && !open.startsWith(`${dir}/`))

/** Hands the keys back to Claude Code's prompt. There is no call for that, but closing a focused
 * pane gives the prompt the keys, and reopening it unasked puts the pane back without taking them. */
async function leavePane($: Engine) {
  await $.ui.close({ id: PANE })
  // Reopening in the same breath as the close can leave the pane placed but never drawn again (a
  // blank box with only the divider). Let the close settle, reopen, then ask for a redraw until
  // one has actually happened, rather than trusting a fixed delay.
  await $.clock.sleep(100)
  const before = draws
  await openPane($)
  for (let tries = 0; tries < 8 && draws === before; tries++) {
    $.ui.invalidate('ui.render')
    await $.clock.sleep(60)
  }
}

/** Writes the Client's buffer back, refusing when the file changed on disk since it was opened. */
async function saveFile($: Engine, op: Extract<NavOp, { op: 'save' }>) {
  const repo = await read($, index)
  if (!repo) return
  const path = toRepoPath(repo.root, repo.root, op.path)
  if (path === undefined || path !== op.path) return notify($, `${op.path} is outside the repo`, 'error')
  const abs = `${repo.root}/${path}`
  const stat = await $.fs.stat(abs).catch(() => undefined)
  if (stat && !op.force && Math.abs(stat.mtimeMs - op.baseMtimeMs) > 1) {
    return notify($, `${path} changed on disk: ctrl+s again overwrites it`, 'warn')
  }
  let text = op.text
  // The pane edits normalised text: give the file back its CRLF endings and BOM.
  const before = stat ? await $.fs.read(abs).catch(() => '') : ''
  if (before.includes('\r\n') && !text.includes('\r\n')) text = text.replace(/\n/g, '\r\n')
  if (before.charCodeAt(0) === 0xfeff && text.charCodeAt(0) !== 0xfeff) text = `\ufeff${text}`
  try {
    await $.fs.write(abs, text)
  } catch (error) {
    return notify($, `could not save ${path}: ${errText(error, 'write failed')}`, 'error')
  }
  await notify($, `saved ${path}`, 'info')
  await update($, revision, n => n + 1)
  await refreshGit($)
}

/** One op from the pane's Client: a key press or a click the person made there. */
async function handleOp($: Engine, op: NavOp) {
  switch (op.op) {
    case 'cursor':
      return setView($, v => ({ ...v, cursor: op.path }))
    case 'open':
      return showFile($, op.path)
    case 'toggle':
      return setView($, v => ({
        ...v,
        cursor: op.path,
        expanded: v.expanded.includes(op.path) ? collapsed(v.expanded, op.path) : [...v.expanded, op.path],
      }))
    case 'expand':
      return setView($, v => ({ ...v, cursor: op.path, expanded: v.expanded.includes(op.path) ? v.expanded : [...v.expanded, op.path] }))
    case 'collapse':
      return setView($, v => ({ ...v, cursor: op.path, expanded: collapsed(v.expanded, op.path) }))
    case 'back':
      return setView($, v => ({ ...v, mode: 'tree', editing: undefined, cursor: v.openPath ?? v.cursor, cursorAt: v.cursorAt + 1 }))
    case 'page':
      return setView($, v => ({ ...v, page: Math.max(0, op.page) }))
    case 'raw':
      return setView($, v => ({ ...v, isRaw: !v.isRaw }))
    case 'diff':
      return setView($, v => ({ ...v, showDiff: !v.showDiff }))
    case 'edit':
      return setView($, v => ({ ...v, editing: op.isEditing ? op.path : undefined }))
    case 'save':
      return saveFile($, op)
    case 'type':
      // Typing outside the editor is meant for Claude: put it in the prompt and give the prompt the keys.
      await $.prompt.fill({ text: op.text, mode: 'insert' })
      return leavePane($)
    case 'leave':
      return leavePane($)
  }
}

/** A Client's props must be plain JSON: drop the optional fields that are unset (undefined is refused). */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Tree rows in the Client's compact form, cut to fit its props. */
function navRows(rows: TreeRow[]): { rows: NavRow[]; sent: number } {
  const out: NavRow[] = []
  let budget = NAV_ROW_BUDGET
  for (const row of rows) {
    const flags = `${row.kind === 'dir' ? 'd' : ''}${row.isExpanded ? 'o' : ''}${row.hasChanges ? 'c' : ''}${row.isTouched ? 't' : ''}${row.mark ?? ''}`
    const matches = row.matches?.flat()
    budget -= row.path.length + flags.length + 12 + (matches?.length ?? 0) * 4
    if (budget < 0) break
    out.push(matches ? [row.path, row.depth, flags, matches] : [row.path, row.depth, flags])
  }
  return { rows: out, sent: out.length }
}

const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/** Resolves what the person typed after /repo: a file, a folder, or a query. */
async function resolveArg($: Engine, arg: string) {
  const repo = await read($, index)
  if (!repo) return { kind: 'query' as const, value: arg }
  const path = toRepoPath(repo.root, await $.session.cwd(), arg)
  if (path !== undefined) {
    const stat = await $.fs.stat(`${repo.root}/${path}`).catch(() => undefined)
    if (stat?.kind === 'file') return { kind: 'file' as const, value: path }
    if (stat?.kind === 'dir') return { kind: 'dir' as const, value: path }
  }
  return { kind: 'query' as const, value: arg }
}

/** /repo and /files: no argument toggles the pane; a file opens it, a folder reveals it, anything else searches. */
async function runCommand($: Engine, args: string, columns: number): Promise<{ text?: string }> {
  const arg = args.trim()
  if (columns > 0) termColumns = columns
  const panes = await $.ui.panes()
  const isOpen = panes.some(pane => pane.id === PANE && pane.isPlaced)
  if (!(await read($, index))) await refreshAll($)

  if (arg === '') {
    if (isOpen) {
      await closeByUser($)
      return {}
    }
    await $.store.set(OPEN_KEY, true)
    const opened = await openPane($, true)
    return opened.isPlaced ? {} : { text: `repoviewer: could not open the pane (${opened.reason})` }
  }

  const target = await resolveArg($, arg)
  if (target.kind === 'file') {
    await showFile($, target.value)
  } else if (target.kind === 'dir') {
    await setView($, v => ({
      ...v,
      mode: 'tree',
      filter: '',
      cursor: target.value,
      cursorAt: v.cursorAt + 1,
      expanded: [...new Set([...v.expanded, ...parentDirs(target.value), target.value])],
    }))
  } else {
    await setView($, v => ({ ...v, mode: 'tree', filter: target.value }))
  }
  await $.store.set(OPEN_KEY, true)
  await openPane($, true)
  return {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const name of COMMANDS) {
      await $.command.register({
        name,
        description: `Browse the repo in a side pane: /${name} to toggle, /${name} <file|folder|query> to jump`,
        argumentHint: '[file|folder|query]',
        // Opens the pane mid-turn too, so you can watch Claude's edits land.
        immediate: true,
      })
    }
    await $.tool.register({
      name: 'show_file',
      description:
        "Show a file to the user in the repoviewer pane beside the conversation (syntax-highlighted, markdown rendered). Use when the user asks to see, open or look at a file, or to point them at the code you're discussing. Does not return the file's content.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
          line: { type: 'number', description: 'Optional 1-based line to bring into view' },
        },
        required: ['path'],
      },
    })
    if ((await $.store.get(FOLLOW_KEY)) === false) await setView($, v => ({ ...v, follow: false }))

    // Loading the file list can take a moment in a big repo: never hold the first prompt for it.
    $.clock.after(0, () => {
      void loadIfMissing($).then(async () => {
        if ((await $.store.get(OPEN_KEY)) !== false) await openPane($)
      })
    })
    let lastSeen = 0
    $.clock.every(POLL_MS, () => {
      void (async () => {
        if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
        await loadIfMissing($)
        await refreshGit($)
        // An open file changed on disk by someone else: re-read it.
        const [repo, current] = [await read($, index), await read($, view)]
        if (!repo || current.mode !== 'file' || !current.openPath) return
        const stat = await $.fs.stat(`${repo.root}/${current.openPath}`).catch(() => undefined)
        if (stat && lastSeen !== 0 && stat.mtimeMs !== lastSeen) await update($, revision, n => n + 1)
        lastSeen = stat?.mtimeMs ?? 0
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'files' }, ($, e) => runCommand($, e.args, e.presentation.columns))
  on('command.run', { command: 'repo' }, ($, e) => runCommand($, e.args, e.presentation.columns))
  on('command.run', { command: 'repoviewer' }, ($, e) => runCommand($, e.args, e.presentation.columns))

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'nav') return next(e)
    await handleOp($, e.data as NavOp)
    return {}
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { path?: unknown; line?: unknown }
    const repo = (await read($, index)) ?? (await refreshAll($), await read($, index))
    if (!repo || typeof input.path !== 'string') return { result: 'No repo loaded, or no path given.' }
    const path = toRepoPath(repo.root, await $.session.cwd(), input.path)
    if (path === undefined) return { result: `${input.path} is outside the repo at ${repo.root}.` }
    if (!(await $.fs.exists(`${repo.root}/${path}`))) return { result: `${path} does not exist.` }
    await showFile($, path, typeof input.line === 'number' ? input.line : undefined)
    return { result: `Showing ${path} in the repo pane.` }
  })

  // Claude's own edits: mark the file, re-read it, and follow it when asked to.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!EDIT_TOOLS.has(e.tool) || ran.deny !== undefined || ran.isError) return ran
    const filePath = e.tool === 'NotebookEdit' ? e.notebook_path : e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined
    const repo = await read($, index)
    if (!repo || typeof filePath !== 'string') return ran
    const path = toRepoPath(repo.root, await $.session.cwd(), filePath)
    if (path === undefined) return ran

    await update($, touched, marks => ({ ...marks, [path]: (marks[path] ?? 0) + 1 }))
    if (!repo.files.includes(path)) {
      await update($, index, current =>
        current && !current.files.includes(path) ? { ...current, files: [...current.files, path].sort() } : current,
      )
    }
    const now = await read($, view)
    if (now.follow && now.editing === undefined) {
      await setView($, v => ({
        ...v,
        mode: 'file',
        openPath: path,
        cursor: path,
        cursorAt: v.cursorAt + 1,
        page: v.openPath === path ? v.page : 0,
        expanded: [...new Set([...v.expanded, ...parentDirs(path)])],
      }))
    }
    await update($, revision, n => n + 1)
    await refreshGit($)
    return ran
  })

  // Bash and other tools change files too: catch up once the turn is over.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (await read($, index)) await refreshAll($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    draws += 1
    const el = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const [repo, marks, edits, current] = [await read($, index), await read($, git), await read($, touched), await read($, view)]
    if (!repo) $.clock.after(0, () => void loadIfMissing($))

    // Docked: the terminal is the transcript beside the pane, the pane, and the divider between.
    // Size the dock once per terminal width, so a width the person drags stays theirs.
    if (e.props.placement === 'dock' && e.viewport?.columns) {
      termColumns = e.viewport.columns + columns + 1
      if (termColumns !== sizedFor && paneWidth() !== undefined) {
        sizedFor = termColumns
        $.clock.after(0, () => void openPane($))
      }
    }

    // The keyboard Client: terminal and desktop draw one; the editor's surfaces fall back to buttons.
    const hasClient = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in el
    const nav = (props: NavProps, height: number) =>
      'Client' in el ? <el.Client key="nav" module="./nav.tsx" props={plain(props)} height={height} /> : undefined
    const navBase = {
      columns,
      surface: e.surface === 'desktop' ? ('desktop' as const) : ('terminal' as const),
      cursor: current.cursor,
      cursorAt: current.cursorAt,
      line: current.line,
      lineAt: current.lineAt,
      editing: current.editing,
      notice: current.notice,
    }

    if (current.mode === 'file' && current.openPath && repo) {
      await read($, revision)
      const path = current.openPath
      const doc = await loadDoc($, repo.root, path)
      const isText = doc.kind === 'text' || doc.kind === 'markdown'
      const isWhole = isText && (doc.text?.length ?? 0) <= NAV_MAX_TEXT
      // The Client holds a file up to NAV_MAX_TEXT whole and scrolls it itself; past that, and without a Client, it pages.
      const page: DocPage | undefined = !isText
        ? undefined
        : hasClient && isWhole
          ? { text: doc.text ?? '', startLine: 1, pageCount: 1 }
          : pageOf(doc, current.page)
      const diff = current.showDiff ? await loadDiff($, repo.root, path) : undefined
      let body: ReturnType<typeof nav>
      if (hasClient && doc.kind !== 'image') {
        const shown = isWhole ? { text: doc.text ?? '', startLine: 1, pageCount: 1 } : page
        const file: NavFile = {
          path,
          kind: doc.kind,
          text: shown?.text,
          startLine: shown?.startLine ?? 1,
          page: isWhole ? 0 : Math.min(current.page, (shown?.pageCount ?? 1) - 1),
          pageCount: shown?.pageCount ?? 1,
          lineCount: doc.lineCount,
          size: doc.size,
          mtimeMs: doc.mtimeMs,
          isEditable: isWhole,
          isRaw: current.isRaw,
          showDiff: current.showDiff,
          diff,
          mark: marks[path],
          isTouched: (edits[path] ?? 0) > 0,
        }
        body = nav({ ...navBase, mode: 'file', rows: Math.max(4, rows - FILE_CHROME), file }, Math.max(4, rows - FILE_CHROME))
      }
      return Viewer(el, {
        surface: e.surface,
        columns,
        rows,
        doc,
        page,
        diff,
        view: current,
        mark: marks[path],
        isTouched: (edits[path] ?? 0) > 0,
        repoName: baseName(repo.root),
        body,
        actions: {
          close: () => void closeByUser($),
          back: () => void handleOp($, { op: 'back' }),
          setPage: page => void setView($, v => ({ ...v, page: Math.max(0, page) })),
          toggleRaw: () => void setView($, v => ({ ...v, isRaw: !v.isRaw })),
          toggleDiff: () => void setView($, v => ({ ...v, showDiff: !v.showDiff })),
          reveal: () => {
            void setView($, v => ({
              ...v,
              mode: 'tree',
              filter: '',
              editing: undefined,
              cursor: path,
              cursorAt: v.cursorAt + 1,
              expanded: [...new Set([...v.expanded, ...parentDirs(path)])],
            })).then(() => $.clock.after(50, () => void $.ui.scroll({ to: { key: `row:${path}` }, in: PANE, block: 'center' })))
          },
        },
      })
    }

    const isFiltering = current.filter.trim() !== ''
    const listed = !repo
      ? { rows: [], total: 0 }
      : isFiltering
        ? filterRows(repo, current.filter, marks, edits)
        : { rows: treeRows(repo, new Set(current.expanded), marks, edits), total: 0 }

    let body: ReturnType<typeof nav>
    if (hasClient) {
      const compact = navRows(listed.rows)
      const total = isFiltering ? Math.max(listed.total, listed.rows.length) : listed.rows.length
      const height = Math.max(4, rows - treeChromeRows(rows))
      body = nav(
        {
          ...navBase,
          mode: 'tree',
          rows: height,
          tree: repo ? { rows: compact.rows, more: total - compact.sent, isFiltering, query: current.filter } : undefined,
        },
        height,
      )
    }

    return Tree(el, {
      surface: e.surface,
      columns,
      rows,
      index: repo,
      rows_: hasClient ? [] : listed.rows,
      total: listed.total,
      view: current,
      changedCount: Object.keys(marks).length,
      touchedCount: Object.keys(edits).length,
      body,
      actions: {
        press: row => void handleOp($, row.kind === 'dir' ? { op: 'toggle', path: row.path } : { op: 'open', path: row.path }),
        setFilter: query => void setView($, v => ({ ...v, filter: query })),
        close: () => void closeByUser($),
        collapseAll: () => void setView($, v => ({ ...v, expanded: [], filter: '' })),
        refresh: () => {
          void refreshAll($).then(() => $.ui.toast('repoviewer: refreshed'))
        },
        toggleFollow: () => void toggleFollow($),
        openFirstMatch: () => {
          void (async () => {
            const [latest, now] = [await read($, index), await read($, view)]
            if (!latest || now.filter.trim() === '') return
            const first = filterRows(latest, now.filter, await read($, git), await read($, touched), 1).rows[0]
            if (!first) return
            // Like an editor's quick open, the finder resets once it has opened something: coming
            // back shows the whole tree (the field itself comes back empty, so a kept query would hide files).
            await setView($, v => ({ ...v, filter: '' }))
            await showFile($, first.path)
          })()
        },
      },
    })
  })
}
