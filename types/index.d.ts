// repo-view's type contract: every value it keeps in $.state, and the shapes
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
}

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
    'repo-view': {
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
