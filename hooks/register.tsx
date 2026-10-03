import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DocPage, FileDoc, GitMark, RepoIndex, RepoView } from '../types'
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

const PANE = 'canopy'
const TOOL = 'mcp__canopy__show_file'
/** `/files` is the name the CLI's feature request asked for; `/repo` the short one. */
const COMMANDS = ['repo', 'files'] as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/** How often the pane notices changes made outside Claude (another editor, a git checkout). */
const POLL_MS = 8000

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

const index = atom({ plugin: 'canopy', key: 'index' } as const, null)
const git = atom({ plugin: 'canopy', key: 'git' } as const, {})
const touched = atom({ plugin: 'canopy', key: 'touched' } as const, {})
const view = atom({ plugin: 'canopy', key: 'view' } as const, DEFAULT_VIEW)
const revision = atom({ plugin: 'canopy', key: 'revision' } as const, 0)

type Engine = EngineInterface

const setView = ($: Engine, change: (v: RepoView) => RepoView) => update($, view, change)

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
    page,
    showDiff: false,
    expanded: [...new Set([...v.expanded, ...parentDirs(path)])],
  }))
  await $.ui.open({ id: PANE, title: repo ? baseName(repo.root) : 'Repo' })
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
async function runCommand($: Engine, args: string): Promise<{ text?: string }> {
  const arg = args.trim()
  const panes = await $.ui.panes()
  const isOpen = panes.some(pane => pane.id === PANE && pane.isPlaced)
  if (!(await read($, index))) await refreshAll($)
  const repo = await read($, index)
  const title = repo ? baseName(repo.root) : 'Repo'

  if (arg === '') {
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return {}
    }
    const opened = await $.ui.open({ id: PANE, title, focus: true })
    return opened.isPlaced ? {} : { text: `canopy: could not open the pane (${opened.reason})` }
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
      expanded: [...new Set([...v.expanded, ...parentDirs(target.value), target.value])],
    }))
  } else {
    await setView($, v => ({ ...v, mode: 'tree', filter: target.value }))
  }
  await $.ui.open({ id: PANE, title, focus: true })
  return {}
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    for (const name of COMMANDS) {
      await $.command.register({
        name,
        description: `Browse the repo in a side pane: /${name} toggles it, /${name} <file|folder|query> jumps there`,
        argumentHint: '[file|folder|query]',
        // Opens the pane mid-turn too, so you can watch Claude's edits land.
        immediate: true,
      })
    }
    await $.tool.register({
      name: 'show_file',
      description:
        "Show a file to the user in the canopy pane beside the conversation (syntax-highlighted, markdown rendered). Use when the user asks to see, open or look at a file, or to point them at the code you're discussing. Does not return the file's content.",
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

    // Loading the file list can take a moment in a big repo: never hold the first prompt for it.
    $.clock.after(0, () => {
      void refreshAll($).then(async () => {
        if (options.autoOpen !== false) {
          const repo = await read($, index)
          await $.ui.open({ id: PANE, title: repo ? baseName(repo.root) : 'Repo' })
        }
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

  on('command.run', { command: 'repo' }, ($, e) => runCommand($, e.args))
  on('command.run', { command: 'files' }, ($, e) => runCommand($, e.args))

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
    if ((await read($, view)).follow) {
      await setView($, v => ({
        ...v,
        mode: 'file',
        openPath: path,
        cursor: path,
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

    if (current.mode === 'file' && current.openPath && repo) {
      await read($, revision)
      const path = current.openPath
      const doc = await loadDoc($, repo.root, path)
      const page: DocPage | undefined =
        doc.kind === 'text' || doc.kind === 'markdown' ? pageOf(doc, current.page) : undefined
      const diff = current.showDiff ? await loadDiff($, repo.root, path) : undefined
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
        actions: {
          back: () => void setView($, v => ({ ...v, mode: 'tree' })),
          setPage: page => void setView($, v => ({ ...v, page: Math.max(0, page) })),
          toggleRaw: () => void setView($, v => ({ ...v, isRaw: !v.isRaw })),
          toggleDiff: () => void setView($, v => ({ ...v, showDiff: !v.showDiff })),
          reveal: () => {
            void setView($, v => ({
              ...v,
              mode: 'tree',
              filter: '',
              cursor: path,
              expanded: [...new Set([...v.expanded, ...parentDirs(path)])],
            })).then(() => $.clock.after(50, () => void $.ui.scroll({ to: { key: `row:${path}` }, in: PANE, block: 'center' })))
          },
        },
      })
    }

    const isFiltering = current.filter.trim() !== ''
    const expanded = new Set(current.expanded)
    const listed = !repo
      ? { rows: [], total: 0 }
      : isFiltering
        ? filterRows(repo, current.filter, marks, edits)
        : { rows: treeRows(repo, expanded, marks, edits), total: 0 }

    return Tree(el, {
      surface: e.surface,
      columns,
      rows,
      index: repo,
      rows_: listed.rows,
      total: listed.total,
      view: current,
      changedCount: Object.keys(marks).length,
      touchedCount: Object.keys(edits).length,
      actions: {
        press: row => {
          if (row.kind === 'dir') {
            void setView($, v => ({
              ...v,
              cursor: row.path,
              expanded: v.expanded.includes(row.path)
                ? v.expanded.filter(dir => dir !== row.path && !dir.startsWith(`${row.path}/`))
                : [...v.expanded, row.path],
            }))
          } else {
            void showFile($, row.path)
          }
        },
        setFilter: query => void setView($, v => ({ ...v, filter: query })),
        collapseAll: () => void setView($, v => ({ ...v, expanded: [], filter: '' })),
        refresh: () => {
          void refreshAll($).then(() => $.ui.toast('canopy: refreshed'))
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
