// canopy's type contract: every value it keeps in $.state, and the shapes
// its modules hand each other. Paths are repo-relative with '/' separators.

/** A file's git state: Modified, Added, Deleted, Renamed, untracked (?), conflict (U). */
export type GitMark = 'M' | 'A' | 'D' | 'R' | '?' | 'U'

/** The repo's file list, loaded once and on refresh. */
export type RepoIndex = {
  /** Absolute project root (git top level, else the session's project root). */
  root: string
  isGit: boolean
  branch?: string
  /** Every file path, sorted, at most MAX_FILES. Directories are implied by paths. */
  files: string[]
  /** True when the listing hit MAX_FILES and was cut. */
  isTruncated: boolean
  loadedAt: number
}

/** What the pane shows and how; the one value the person's presses change. */
export type RepoView = {
  mode: 'tree' | 'file'
  /** Expanded directory paths. */
  expanded: string[]
  /** The tree row last pressed or revealed ('' none): drawn highlighted. */
  cursor: string
  /** Fuzzy query; non-empty switches the tree to a flat ranked list. */
  filter: string
  /** The file the viewer shows. */
  openPath?: string
  /** 0-based page of the open file. */
  page: number
  /** Markdown drawn as source rather than rendered. */
  isRaw: boolean
  /** Show `git diff HEAD` of the open file instead of its content. */
  showDiff: boolean
  /** Open each file Claude edits as it happens. */
  follow: boolean
  /** The file the person is editing in the pane, if any: follow never pulls the view away from it. */
  editing?: string
  /** Bumped whenever the hooks side moves the cursor (reveal, follow, hotkeys), so the Client adopts it. */
  cursorAt: number
  /** The 1-based line the viewer should bring into view (show_file, follow), with its own bump. */
  line?: number
  lineAt: number
  /** The last outcome the Client should show (saved, conflict, error). */
  notice?: { text: string; tone: 'info' | 'warn' | 'error'; at: number }
}

// ---------------------------------------------------------------------------
// The pane's keyboard Client (hooks/nav.tsx): one `Client` keyed 'nav' draws the
// tree, the file view and the editor, so a click gives it the keys once and the
// arrows keep working as the person moves between them. Props are plain JSON,
// at most 100,000 characters in all: hence compact rows and NAV_MAX_TEXT.

/** A tree row as the Client gets it: [path, depth, flags, matches?].
 * flags: 'd' dir, 'o' expanded, 'c' dir holds changes, 't' touched by Claude,
 * and at most one git mark letter M A ? D R U. matches: flat [start, end, start, end…] into the shown name. */
export type NavRow = [path: string, depth: number, flags: string, matches?: number[]]

export type NavTree = {
  rows: NavRow[]
  /** Rows left out to keep props small. */
  more: number
  /** Filter mode: rows are ranked matches and the shown name is the whole path. */
  isFiltering: boolean
  query: string
}

export type NavFile = {
  path: string
  kind: FileDoc['kind']
  /** The whole text when it is at most NAV_MAX_TEXT characters, else the current page. */
  text?: string
  startLine: number
  page: number
  pageCount: number
  lineCount: number
  size: number
  mtimeMs: number
  /** Text or markdown held whole: the Client may edit it. */
  isEditable: boolean
  isRaw: boolean
  showDiff: boolean
  diff?: { hunks: string; isTruncated: boolean }
  mark?: GitMark
  isTouched: boolean
}

export type NavProps = {
  mode: 'tree' | 'file'
  /** The region the Client is given, in cells. */
  columns: number
  rows: number
  surface: 'terminal' | 'desktop'
  tree?: NavTree
  file?: NavFile
  cursor: string
  cursorAt: number
  line?: number
  lineAt: number
  editing?: string
  notice?: { text: string; tone: 'info' | 'warn' | 'error'; at: number }
}

/** What the Client posts to the hooks module (`ui.message` e.data). One post per key press:
 * a later post in the same frame replaces an undelivered one. */
export type NavOp =
  | { op: 'cursor'; path: string }
  | { op: 'open'; path: string }
  | { op: 'toggle'; path: string }
  | { op: 'expand'; path: string }
  | { op: 'collapse'; path: string }
  | { op: 'back' }
  | { op: 'page'; page: number }
  | { op: 'raw' }
  | { op: 'diff' }
  | { op: 'edit'; path: string; isEditing: boolean }
  | { op: 'save'; path: string; text: string; baseMtimeMs: number; force: boolean }


/** One row the tree draws. */
export type TreeRow = {
  path: string
  /** Last path segment in tree mode; the whole path in filter mode. */
  name: string
  depth: number
  kind: 'file' | 'dir'
  isExpanded: boolean
  /** The file's own git mark. */
  mark?: GitMark
  /** For a dir: some file beneath it has a git mark. */
  hasChanges?: boolean
  /** Claude edited this file (or, for a dir, something beneath it) this session. */
  isTouched: boolean
  /** Filter mode: [start, end) character ranges of `name` that matched the query. */
  matches?: Array<[number, number]>
}

/** A file loaded for the viewer. */
export type FileDoc = {
  path: string
  kind: 'text' | 'markdown' | 'image' | 'binary' | 'too-large' | 'missing'
  /** Whole text for text/markdown. */
  text?: string
  lineCount: number
  size: number
  mtimeMs: number
  /** Absolute path, for kind 'image' (PNG only; drawn by Image { file, format: 'png' }). */
  absPath?: string
  /** Why it could not be read, for 'missing'. */
  error?: string
}

/** One page of a text doc, sized for Code/Markdown's 10000-character limit. */
export type DocPage = { text: string; startLine: number; pageCount: number }

declare module 'claude-code' {
  interface PluginState {
    'canopy': {
      index: RepoIndex | null
      /** path → mark, from `git status`. */
      git: Record<string, GitMark>
      /** path → number of Claude's edits this session. */
      touched: Record<string, number>
      view: RepoView
      /** Bumped whenever a file may have changed on disk (Claude's edits, refresh): the viewer re-reads. */
      revision: number
    }
  }
}
