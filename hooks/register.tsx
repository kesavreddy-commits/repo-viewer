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
import { Tree } from './tree'
import { Viewer } from './viewer'

const PANE = 'repo-viewer'
const TOOL = 'mcp__repo-viewer__show_file'
/** `/files` is the name the CLI's feature request asked for; `/repo` the short one; `/repo-viewer` its own. */
const COMMANDS = ['files', 'repo', 'repo-viewer'] as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/** How often the pane notices changes made outside Claude (another editor, a git checkout). */
const POLL_MS = 8000
/** A file at most this long goes to the pane's Client whole, and can be edited there. */
const NAV_MAX_TEXT = 90000
/** Characters of tree rows handed to the Client (its props are bounded at 100,000). */
const NAV_ROW_BUDGET = 60000
/** Rows the hooks-drawn chrome takes above the Client: tree header, counts, finder, toolbar; viewer header, meta, toolbar. */
const TREE_CHROME = 4
const FILE_CHROME = 3

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

const index = atom({ plugin: 'repo-viewer', key: 'index' } as const, null)
const git = atom({ plugin: 'repo-viewer', key: 'git' } as const, {})
const touched = atom({ plugin: 'repo-viewer', key: 'touched' } as const, {})
const view = atom({ plugin: 'repo-viewer', key: 'view' } as const, DEFAULT_VIEW)
const revision = atom({ plugin: 'repo-viewer', key: 'revision' } as const, 0)

type Engine = EngineInterface

const setView = ($: Engine, change: (v: RepoView) => RepoView) => update($, view, change)

/** The terminal's width as last measured, and the width it was when the dock was last sized. */
let termColumns = 0
let sizedFor = 0
let widthPercent = 40

/** The dock width to ask for: 40% of the terminal, at least 44 columns so code stays readable, at
 * most 100 so a wide screen keeps its transcript, and never leaving Claude under 70 columns. Below
 * that (a terminal of about 115 columns or less) it asks for nothing and the engine's share stands. */
function paneWidth(): number | undefined {
  if (termColumns <= 0) return undefined
  const want = Math.min(100, Math.max(44, Math.round((termColumns * widthPercent) / 100)), termColumns - 70)
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

async function run($: Engine, argv: string[], cwd: string, timeoutMs = 20000) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch {
    return undefined
  }
}

async function loadIndex($: Engine): Promise<RepoIndex> {
  const cwd = await $.session.cwd().catch(() => '')
  const loadedAt = await $.clock.now().catch(() => 0)
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'], cwd)
  const root = top?.exitCode === 0 ? top.stdout.trim() : ''
  if (root !== '') {
    const [ls, sym, sha] = await Promise.all([
      run($, ['git', '--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, 30000),
      run($, ['git', 'symbolic-ref', '--short', '-q', 'HEAD'], root),
      run($, ['git', 'rev-parse', '--short', 'HEAD'], root),
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
  const status = await run($, ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root, 30000)
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
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv', '--', path]
  let diff = await run($, ['git', '--no-optional-locks', 'diff', 'HEAD', ...flags], root)
  // A repo with no commit yet has no HEAD to diff against.
  if (diff?.exitCode !== 0) diff = await run($, ['git', '--no-optional-locks', 'diff', ...flags], root)
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
  await openPane($)
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
      await $.ui.close({ id: PANE })
      return {}
    }
    const opened = await openPane($, true)
    return opened.isPlaced ? {} : { text: `repo-viewer: could not open the pane (${opened.reason})` }
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
  await openPane($, true)
  return {}
}

export const register: Register = (on, options) => {
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
        "Show a file to the user in the repo-viewer pane beside the conversation (syntax-highlighted, markdown rendered). Use when the user asks to see, open or look at a file, or to point them at the code you're discussing. Does not return the file's content.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
          line: { type: 'number', description: 'Optional 1-based line to bring into view' },
        },
        required: ['path'],
      },
    })
    if (options.follow === false) await setView($, v => ({ ...v, follow: false }))
    if (typeof options.width === 'number' && options.width >= 20 && options.width <= 70) widthPercent = options.width

    // Loading the file list can take a moment in a big repo: never hold the first prompt for it.
    $.clock.after(0, () => {
      void refreshAll($).then(async () => {
        if (options.autoOpen !== false) await openPane($)
      })
    })
    let lastSeen = 0
    $.clock.every(POLL_MS, () => {
      void (async () => {
        if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
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

  // /clear, /resume and /branch reset every $.state value and fire no session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const done = await next(e)
    await refreshAll($)
    return done
  })

  on('command.run', { command: 'files' }, ($, e) => runCommand($, e.args, e.presentation.columns))
  on('command.run', { command: 'repo' }, ($, e) => runCommand($, e.args, e.presentation.columns))
  on('command.run', { command: 'repo-viewer' }, ($, e) => runCommand($, e.args, e.presentation.columns))

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
    const el = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const [repo, marks, edits, current] = [await read($, index), await read($, git), await read($, touched), await read($, view)]

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
        body,
        actions: {
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
      const height = Math.max(4, rows - TREE_CHROME)
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
        collapseAll: () => void setView($, v => ({ ...v, expanded: [], filter: '' })),
        refresh: () => {
          void refreshAll($).then(() => $.ui.toast('repo-viewer: refreshed'))
        },
        toggleFollow: () => void setView($, v => ({ ...v, follow: !v.follow })),
        openFirstMatch: () => {
          void (async () => {
            const [latest, now] = [await read($, index), await read($, view)]
            if (!latest || now.filter.trim() === '') return
            const first = filterRows(latest, now.filter, await read($, git), await read($, touched), 1).rows[0]
            if (first) await showFile($, first.path)
          })()
        },
      },
    })
  })
}
