# repo-view: spec

A Claude Code **mod** (plugin of function hooks, Claude Code 2.1.286) that docks a
full repo browser beside the transcript in the **terminal** CLI, giving the CLI what
the desktop app's file pane gives: the repo tree with git markers, fuzzy find, and a
file viewer (syntax-highlighted code, rendered markdown, git diff, PNG images).
Terminal is the primary surface; desktop must not break (no `Image` there).

Look: match Claude Code's own CLI. Plain, quiet, dim secondary text, one accent.
Safe ANSI color names only: `green`, `yellow`, `red`, `cyan`, `magenta`, `blue`, `gray`.
Fonts are the host's; a mod cannot set them.

## Runtime rules (read before writing)

- Mod API declarations (authority, 18k lines, grep it):
  `/private/tmp/claude-501/bundled-skills/2.1.286/da596c6aeada0858a1992645f688d860/plugin-authoring/types/claude-code.d.ts`
- Long-form guide: `.../plugin-authoring/reference.md`; examples in `.../plugin-authoring/examples/`.
- Modules run with **no DOM and no Node**: no `fs`, `path`, `process`, `setTimeout`,
  `require`. Everything outside goes through `$` (`$.fs.read/list/stat/exists`,
  `$.process.run(argv, { cwd, timeoutMs })`, `$.session.cwd()`, `$.clock.now()`).
- JSX compiles against the global `h`; never import/declare `h` or `Fragment`, no `@jsx` pragma.
  Element constructors are NOT globals; components receive the surface's table.
- `import type { ... } from 'claude-code'` for engine types; `import type { ... } from '../types'` for ours.
- Limits: `Code.source` and `Markdown.text` ≤ 10000 chars (tab/newline the only control
  chars, so strip other control chars incl. `\r`). `$.fs.read` rejects > 4 MiB.
  Button `hotkey` = one digit or one lowercase letter; two clashing → later wins.
- Check work with: `claude plugin validate /Users/kesav/claudecodemods/mod1`

## Files and owners

| File | Owner | What |
| --- | --- | --- |
| `types/index.d.ts` | lead | state contract + shared shapes (`RepoIndex`, `RepoView`, `TreeRow`, `FileDoc`, `DocPage`, `GitMark`). Do not edit; ask the lead. |
| `hooks/register.tsx` | lead | wiring: commands, state atoms, tool.call tracking, render dispatch, actions |
| `hooks/repo.ts` | agent A | data layer: pure parsers (the I/O moved into register.tsx, since the engine follows `$` only within one file) |
| `hooks/viewer.tsx` | agent B | file viewer component |
| `hooks/tree.tsx` | agent C | tree / finder component |
| `tests/*.test.ts(x)` | later | `claude plugin test` |

## hooks/repo.ts (agent A): data layer, no JSX

`type Engine = import('claude-code').EngineInterface` is `$`.

```ts
export const MAX_FILES = 20000
export const PAGE_CHARS = 9000      // per page, under Code's 10000 limit
export const PAGE_LINES = 400

// Root: `git rev-parse --show-toplevel` from $.session.cwd(); else cwd.
// Files: `git ls-files -z --cached --others --exclude-standard` (respects .gitignore,
// includes untracked); dedupe, sort, cap MAX_FILES. Not a git repo → walk with
// $.fs.list, skipping IGNORED_DIRS, cap MAX_FILES. Branch: `git rev-parse --abbrev-ref HEAD`.
export const IGNORED_DIRS: ReadonlySet<string>  // .git node_modules dist build .next target __pycache__ .venv venv .cache coverage .DS_Store …
export async function loadIndex($: Engine): Promise<RepoIndex>

// `git status --porcelain=v1 -z --untracked-files=all` in root → path → GitMark.
// Renames: mark the new path 'R' (porcelain -z puts the old path as the next NUL field: skip it).
// Conflicts (UU, AA, DD, AU, UA, DU, UD) → 'U'. Not git → {}.
export async function loadGitStatus($: Engine, root: string): Promise<Record<string, GitMark>>

// Directories implied by index.files. Visible rows of the tree: top level, plus children of
// each expanded dir, recursively. Dirs first, then files; case-insensitive natural sort.
// mark/hasChanges from git; isTouched from touched (dirs: any descendant touched).
// Deleted files ('D' in git but absent from index.files) are still listed so they show.
export function treeRows(index: RepoIndex, expanded: ReadonlySet<string>,
  git: Record<string, GitMark>, touched: Record<string, number>): TreeRow[]

// Fuzzy subsequence match over full paths (files only), fzf-like scoring: consecutive runs,
// matches at segment starts (after '/', '_', '-', '.') and in the basename score higher;
// shorter paths break ties. Smart case (case-sensitive only if query has an uppercase).
// Space-separated terms must all match. Returns at most `limit` rows, depth 0, name = path,
// `matches` = merged [start,end) ranges into the path.
export function filterRows(index: RepoIndex, query: string, git: Record<string, GitMark>,
  touched: Record<string, number>, limit?: number): { rows: TreeRow[]; total: number }

export function parentDirs(path: string): string[]       // 'a/b/c.ts' → ['a', 'a/b']

// Absolute or relative tool path → repo-relative ('/' separators, no './'), undefined if outside root.
export function toRepoPath(root: string, cwd: string, filePath: string): string | undefined

// Read for the viewer. stat first: missing → 'missing' (error text). size > 4 MiB → 'too-large'.
// .png → 'image' with absPath (don't read it). Other known binary extensions (jpg gif pdf zip
// woff …) or a NUL in the first 8000 chars → 'binary'. .md/.mdx/.markdown → 'markdown'.
// Else 'text'. Normalise \r\n → \n; strip other control chars except \t \n.
export async function loadDoc($: Engine, root: string, path: string): Promise<FileDoc>

// Split a text doc into pages: each ≤ PAGE_CHARS and ≤ PAGE_LINES, breaking only at line
// boundaries (a single over-long line is hard-cut). page is clamped. startLine is 1-based.
export function pageOf(doc: FileDoc, page: number): DocPage

// `git diff HEAD --no-color --no-ext-diff -- <path>` (fallback `git diff --no-color -- <path>`
// when HEAD doesn't exist). Return only the hunks (from the first '@@'), cut at a hunk
// boundary to ≤ 9500 chars, with ' … diff truncated' noted by returning isTruncated.
// Untracked or unchanged → undefined.
export async function loadDiff($: Engine, root: string, path: string):
  Promise<{ hunks: string; isTruncated: boolean } | undefined>

export function formatSize(bytes: number): string          // 812 B, 4.2 KB, 1.3 MB
```

## Components (agents B and C): pure, synchronous

Signature: `(el, ctx) => RenderElement`, where `el` is `ElementTable` from
`$.ui.resolve(e)` (types: `import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'`).
No `$`, no state reads, no async: register.tsx loads data and passes callbacks.
Use JSX with tags destructured from `el` (`const { Box, Text, Button } = el`).
Every Button needs a stable unique `key`. Size everything to `ctx.columns` (the pane body width,
often only 40–70 columns): truncate with `wrap="truncate-end"` / `truncate-middle` on long names.

### hooks/viewer.tsx (agent B)

```ts
export type ViewerActions = {
  back(): void                 // return to tree
  setPage(page: number): void
  toggleRaw(): void            // markdown rendered ↔ source
  toggleDiff(): void
  reveal(): void               // show this file in the tree
}
export type ViewerCtx = {
  surface: RenderSurface
  columns: number; rows: number
  doc: FileDoc
  page: DocPage | undefined     // for text/markdown
  diff: { hunks: string; isTruncated: boolean } | undefined   // loaded only when view.showDiff
  view: RepoView
  mark?: GitMark; isTouched: boolean
  actions: ViewerActions
}
export function Viewer(el: ElementTable, ctx: ViewerCtx): RenderElement
```

Layout, top to bottom:
1. Header: `‹ back` button (hotkey `b`), the path (dirs dim, basename bold, middle-truncated),
   git mark colored, `●` if Claude touched it (color `magenta`).
2. Meta line, dim: `312 lines · 9.4 KB · typescript` / page `2/5`.
3. Toolbar of `plain` Buttons with hotkeys, only those that apply:
   `p` prev, `n` next (multi-page), `r` raw/rendered (markdown), `d` diff/file (when the file has a git mark
   other than '?'), `t` reveal in tree.
4. Body: text → `Code` with `path` and `startLine` (gutter); markdown → `Markdown` rendered unless
   `view.isRaw` (then `Code` with language `markdown`); diff → `Code format="diff"`
   (no diff → dim "No changes against HEAD."); image → on `terminal` an `Image`
   `{ file: absPath, format: 'png', generation: mtimeMs }` sized to fit `columns`×(rows−6), alt = path;
   elsewhere a dim note; binary / too-large / missing → a dim one-line explanation.
5. Footer when paged: dim `lines 401–800 of 3120`.

### hooks/tree.tsx (agent C)

```ts
export type TreeActions = {
  press(row: TreeRow): void    // dir: toggle expand; file: open in viewer
  setFilter(query: string): void
  collapseAll(): void
  refresh(): void
  toggleFollow(): void
  openFirstMatch(): void       // Enter in the finder
}
export type TreeCtx = {
  surface: RenderSurface
  columns: number; rows: number
  index: RepoIndex | null      // null → loading
  rows_: TreeRow[]             // visible rows (tree or filtered)
  total: number                // filter mode: total matches
  view: RepoView
  changedCount: number         // files with a git mark
  touchedCount: number
  actions: TreeActions
}
export function Tree(el: ElementTable, ctx: TreeCtx): RenderElement
```

Layout:
1. Header: repo folder name bold, `⎇ branch` dim (if git), counts dim (`1,204 files · 3 changed · 2 edited by Claude`).
2. Finder: `Input` key `filter`, placeholder `Find file…`, value `view.filter`, `onInput` → setFilter,
   `onSubmit` → openFirstMatch. Skip the Input on surfaces whose table has none (mobile).
3. Toolbar of `plain` Buttons: `g` refresh, `c` collapse all, `f` follow on/off (show state).
4. Rows: each a `plain` Button (key `row:<path>`, label is the whole row text) or a Box of Texts +
   Button; one row per line, never wrapping. Indent 2 spaces per depth. Dirs: `▸ name/` / `▾ name/`.
   Files: `  name`. Right side: git mark letter colored (M yellow, A green, ? green dimmed,
   D red + strikethrough name, R cyan, U red bold); dirs with changes get a dim `•`;
   touched by Claude a `magenta` `●`. The row equal to `view.cursor` draws `inverse` or bold accent.
   Filter mode: show the path with matched ranges highlighted (bold/`cyan`) and dirs dim.
   Cap at 500 drawn rows then a dim `… N more`. Empty states: loading, no matches, empty repo.
5. A one-line dim hint at the bottom: `↑↓ move · ⏎ open · ctrl+x tab focus`.

---

# v2: keyboard Client, arrow navigation, in-pane editing

The plugin is now **canopy** (state key `canopy`, pane id `canopy`, tool `mcp__canopy__show_file`).

## Why a Client

Buttons can't take arrow keys. A `Client` element can: its surface module gets every key
(`up down left right return tab backspace delete home end pageup pagedown`, characters, ctrl/shift/meta)
and pointer events, **once a click has focused it** (verified in the real terminal: Tab never reaches a
Client; Esc gives the keys back to Claude Code's prompt). So the pane body is ONE `Client` keyed `nav`,
module `./nav.tsx`, used in both tree and file mode so its focus survives opening and leaving files.
While the Client has focus, arrows never reach Claude Code (whose ← at the prompt opens past sessions).

Surface module rules (types: grep `export type ClientModule`, `ClientSurface`, `ClientKeyEvent`,
`ClientPointerEvent`, `ClientElements` in `.claude/types/claude-code.d.ts`):
- `export default function Nav(props: NavProps, surface: ClientSurface<NavState>): RenderElement`.
- Elements from `surface.elements` (Box, Text, Button, Input, Select, Link, Code, Markdown; no Client/Image/Raster).
- No `$`, no timers except `surface.every`. Local state via `surface.state` / `surface.setState` (never
  setState on every render: three renders in a row each calling setState with no input between unmounts it).
  Register `surface.onKey` / `surface.onPointer` once, while `surface.state === undefined`; the listeners
  must read the latest state and props, so keep them in a module-level holder updated each render, or read
  `surface.state` at call time (it is the live value) and stash the latest props in the state on change.
- `surface.post(op: NavOp)` reaches the hooks module. **One post per key press**: a later post in the same
  frame replaces an undelivered one.
- Importing plain helpers from the plugin works (verified): `import { … } from './editor'`.
- Nested `<Text>` styling works (`<Text>a <Text inverse>b</Text> c</Text>`).
- Draw at most `props.rows` rows and `props.columns` columns: every row one line (`wrap="truncate-end"`).
- `Code.source` / `Markdown.text` ≤ 10000 chars per element.

Contract types (`types/index.d.ts`): `NavProps`, `NavTree`, `NavRow`, `NavFile`, `NavOp`. Do not edit them;
ask the lead.

## Files

| File | Owner | What |
| --- | --- | --- |
| `hooks/editor.ts` | agent A | pure text buffer with cursor, scrolling, undo |
| `hooks/nav.tsx` | agent B | the Client: state, key/pointer dispatch, tree mode |
| `hooks/navfile.tsx` | agent C | file mode inside the Client: viewer + editor UI |
| `hooks/register.tsx` | lead | props, NavOp handling, saving, hotkeys for keyboard-only use |

## hooks/editor.ts (agent A) — pure, no JSX

```ts
export const TAB_WIDTH = 4
export type Pos = { row: number; col: number }            // col: UTF-16 index into the line
export type Buffer = {
  lines: string[]
  cursor: Pos
  /** Desired display column kept across up/down through short lines. */
  goalCol: number
  /** First visible line and first visible display column. */
  top: number
  left: number
  isDirty: boolean
  /** Undo/redo stacks of snapshots { lines, cursor }, capped at 200; typing coalesces into one step per word. */
  undo: Snapshot[]
  redo: Snapshot[]
}
export function fromText(text: string, cursorRow?: number): Buffer      // '\n' split; trailing '\n' kept on toText
export function toText(b: Buffer): string
export type EditKey = { key: string; ctrl?: true; shift?: true; meta?: true }
/** Apply one key; returns the new buffer (never mutates). Handles: printable chars (insert), return
 * (split line, carry leading whitespace), backspace, delete (join lines at edges), tab (insert '\t' —
 * or two spaces if the file's lines mostly indent with spaces: detect once in fromText), left/right
 * (wrap across lines), up/down (keep goalCol in display columns), home/end, pageup/pagedown (by
 * `viewRows`), ctrl+left/right or meta+left/right (word jumps), ctrl+z undo, ctrl+y / ctrl+shift+z redo,
 * ctrl+k delete to end of line, ctrl+u delete to line start. Unknown keys: unchanged. */
export function applyKey(b: Buffer, k: EditKey, viewRows: number): Buffer
/** Scroll so the cursor is visible in a viewRows × viewCols window (gutter excluded). */
export function scrollIntoView(b: Buffer, viewRows: number, viewCols: number): Buffer
/** The visible window, tabs expanded to TAB_WIDTH: each row's display text (already cut to
 * [left, left+viewCols)), its 1-based line number, and on the cursor's row the cursor's display column
 * within the window. */
export function view(b: Buffer, viewRows: number, viewCols: number):
  { lineNo: number; text: string; cursorCol?: number }[]
export function displayCol(line: string, col: number): number          // tabs → TAB_WIDTH stops
```

## hooks/nav.tsx (agent B) — the Client, tree mode

State (`NavState`, define and export it in nav.tsx):
`{ cursor: string; cursorAt: number; top: number; file: FileState | undefined; lastProps: NavProps }`.
`cursor` is the path highlighted in the tree. Adopt `props.cursor` whenever `props.cursorAt` differs from
the last one seen (the hooks side moved it: reveal, follow, h/j/k/l hotkeys).

Tree keys (when `props.mode === 'tree'`):
- `up`/`k`, `down`/`j`: move; `pageup`/`pagedown`: by a screen; `home`/`g`, `end`/`G`: ends. Post `{op:'cursor', path}`.
- `right`/`l`: collapsed dir → `{op:'expand'}`; expanded dir → move to its first child (post cursor);
  file → `{op:'open'}`.
- `left`/`h`: expanded dir → `{op:'collapse'}`; otherwise move to the parent dir row (post cursor);
  at top level, nothing.
- `return`/space: dir → `{op:'toggle'}`; file → `{op:'open'}`.
- Pointer: `down` on a row selects it; a `down` on the already-selected row (or a quick second click)
  toggles/opens it.

Tree drawing (one line per row, fit `props.columns`): indent 2 per depth, `▸ name/` / `▾ name/`,
files `  name`; right-aligned 3-cell marker cluster: magenta `●` if touched, then the git mark (M yellow,
A green, ? green dim, D red with name strikethrough, R cyan, U red bold), dirs with changes a dim `•`.
Filter mode: name = whole path, middle-ellipsised to fit, `matches` ranges bold cyan. Cursor row:
`inverse` across the row. Scroll: keep the cursor within `top … top + rows - 1` (state.top), draw only
that window, plus a last dim line `… N more` when `props.tree.more > 0` and the window reaches the end.
Empty: `No files match "q"` / `Loading files…` (no `props.tree`).

File mode: delegate entirely to navfile.tsx (`fileKey`, `fileRender`, `filePointer` below); nav.tsx owns
creating/resetting `state.file` with `initFile(props)` when `props.file.path` or `mtimeMs` changes
(but never while `state.file.buffer` is dirty: then keep the buffer and let navfile show the conflict).

## hooks/navfile.tsx (agent C) — file mode

```ts
export type FileState = {
  path: string
  mtimeMs: number
  /** View mode: the first visible line (1-based, within the file) and the cursor line. */
  top: number
  line: number
  /** Markdown: rendered (default) or source. Diff: first visible hunk. */
  hunk: number
  /** Present while editing. */
  buffer?: Buffer
  /** A save was refused because the file changed on disk: the next ctrl+s forces. */
  isConflict: boolean
  lineAt: number
}
export function initFile(props: NavProps, previous?: FileState): FileState
export function fileKey(state: FileState, k: ClientKeyEvent, props: NavProps, post: (op: NavOp) => void): FileState
export function filePointer(state: FileState, p: ClientPointerEvent, props: NavProps, post: (op: NavOp) => void): FileState
export function fileRender(el: ClientElements, state: FileState, props: NavProps): RenderElement
```

View mode keys: `up`/`k` `down`/`j` move the cursor line (scrolling), `pageup`/`pagedown`/space, `home`/`g`
`end`/`G`; `left`/`h` → `{op:'back'}`; `e`/`i`/`return`/`right`/`l` → enter edit mode at the cursor line
when `file.isEditable` (post `{op:'edit', path, isEditing:true}`), else nothing; `r` → `{op:'raw'}`,
`d` → `{op:'diff'}`; `n`/`p` → `{op:'page'}` when paged. Adopt `props.line` when `props.lineAt` changes.
Diff mode: up/down move by hunk, left back to file view (`{op:'diff'}`).

View drawing within `props.rows` × `props.columns`: text → a gutter column of right-aligned line numbers
(dim; the cursor line's bright with `▸`) beside ONE `Code` element holding exactly the visible lines
(`path` for highlighting, `wrap="truncate-end"`, no `startLine`), so rows align 1:1. Markdown rendered →
`Markdown` of the source from the top line (if `top` falls inside a ``` fence, prepend the fence opener),
enough lines to fill the rows. Diff → `Code format="diff"` of the hunks from `hunk` on (each hunk keeps
its `@@` header; never cut a hunk header off), or dim "No changes against HEAD.". Image/binary/
too-large/missing → one dim line saying so and `← back`. Last row: a dim status line:
view: `← back  e edit  r raw  d diff  · 12/340` ; edit: `EDIT ctrl+s save  ctrl+q done  ctrl+z undo · 12:5`
plus `● modified` when dirty, and `props.notice` text (tone colors) when newer than entering the mode.

Edit mode: keys go to `applyKey` from editor.ts, except `ctrl+s` → post `{op:'save', path, text, baseMtimeMs:
state.mtimeMs, force: state.isConflict}`, `ctrl+q` → leave edit mode (if dirty, the first ctrl+q shows
"unsaved changes — ctrl+q again to discard"; the second discards) and post `{op:'edit', isEditing:false}`.
When new props arrive for the same path with a newer `mtimeMs`: if the buffer is clean, reload from the
text; if the text equals the buffer, the save landed: mark clean and adopt the mtime; if dirty and
different, keep the buffer and show "changed on disk — ctrl+s overwrites" (set isConflict). A notice with
tone 'warn' containing 'changed' also sets isConflict. Edit drawing: gutter as in view mode, then each
visible line as plain `Text` (no highlighting) with the cursor cell drawn `inverse` (a space when at end of
line), using `view()` from editor.ts.
