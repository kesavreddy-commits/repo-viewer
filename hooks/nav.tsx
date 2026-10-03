// repo-viewer's keyboard Client: ONE surface module that draws the pane body and
// takes the person's keys once a click has focused it. Tree mode (arrow-key
// navigation, scrolling window, git marks) lives here; file mode (viewer and
// editor) is delegated to ./navfile. The hooks module answers the ops posted
// from here and sends back fresh props.
//
// Rules this file keeps (engine): elements only from `surface.elements`, no `$`,
// one post per key press, setState only from handlers, once on init, or once per
// change of props (guarded), every drawn line one terminal line within
// `props.columns`.
import type { ClientKeyEvent, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'
import type { GitMark, NavOp, NavProps, NavRow } from '../types'
import { fileKey, filePointer, fileRender, initFile } from './navfile'
import type { FileState } from './navfile'

export type NavState = {
  /** The path highlighted in the tree. */
  cursor: string
  /** The last `props.cursorAt` adopted. */
  cursorAt: number
  /** First tree row drawn (index into props.tree.rows). */
  top: number
  /** File mode's state (viewer / editor), created from props.file. */
  file: FileState | undefined
  /** The props last adopted from. */
  lastProps: NavProps
  /** `path|mtimeMs|lineAt` of the file adopted into `file` ('' none): adoption happens once per change. */
  fileSeen: string
}

// ---------------------------------------------------------------- text helpers

const ELLIPSIS = '…'

/** Terminal cells a code point takes: 0 combining, 2 wide, else 1. */
function cellWidth(cp: number): number {
  if (cp === 0) return 0
  if (cp < 0x300) return 1
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x20e3
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += cellWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** Truncate with a trailing ellipsis so the result is at most `max` cells. */
function fit(s: string, max: number): string {
  if (max <= 0) return ''
  if (strWidth(s) <= max) return s
  if (max === 1) return ELLIPSIS
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = cellWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + ELLIPSIS
}

/** One drawn character: its text, cells, and whether the query matched it. */
type Glyph = { s: string; w: number; hit: boolean }

/** Ranges are flat [start, end, start, end…] UTF-16 offsets into `text`. Control characters become '?'. */
function glyphsOf(text: string, ranges: readonly number[] | undefined): Glyph[] {
  const out: Glyph[] = []
  let at = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isControl = cp < 32 || (cp >= 127 && cp < 160)
    let hit = false
    if (ranges) {
      for (let i = 0; i + 1 < ranges.length; i += 2) {
        if (at >= ranges[i]! && at < ranges[i + 1]!) {
          hit = true
          break
        }
      }
    }
    out.push({ s: isControl ? '?' : ch, w: isControl ? 1 : cellWidth(cp), hit })
    at += ch.length
  }
  return out
}

const sumWidth = (g: readonly Glyph[]): number => g.reduce((n, x) => n + x.w, 0)

const ELL: Glyph = { s: ELLIPSIS, w: 1, hit: false }

/** Cut to `max` cells keeping the start (tree names). */
function cutEnd(g: Glyph[], max: number): Glyph[] {
  if (sumWidth(g) <= max) return g
  if (max <= 0) return []
  const out: Glyph[] = []
  let w = 0
  for (const x of g) {
    if (w + x.w > max - 1) break
    out.push(x)
    w += x.w
  }
  out.push(ELL)
  return out
}

/** Cut to `max` cells with the ellipsis in the middle, favouring the tail (the file name). */
function cutMiddle(g: Glyph[], max: number): Glyph[] {
  if (sumWidth(g) <= max) return g
  if (max <= 0) return []
  if (max === 1) return [ELL]
  const room = max - 1
  const headRoom = Math.floor(room / 3)
  const head: Glyph[] = []
  let hw = 0
  for (const x of g) {
    if (hw + x.w > headRoom) break
    head.push(x)
    hw += x.w
  }
  const tail: Glyph[] = []
  let tw = 0
  for (let i = g.length - 1; i >= head.length; i--) {
    const x = g[i]!
    if (tw + x.w > room - hw) break
    tail.unshift(x)
    tw += x.w
  }
  return [...head, ELL, ...tail]
}

// ------------------------------------------------------------------ git marks

type Mark = { ch: string; color: string; dim?: boolean; bold?: boolean }

function markOf(mark: GitMark): Mark {
  switch (mark) {
    case 'M':
      return { ch: 'M', color: 'yellow' }
    case 'A':
      return { ch: 'A', color: 'green' }
    case '?':
      return { ch: '?', color: 'green', dim: true }
    case 'D':
      return { ch: 'D', color: 'red' }
    case 'R':
      return { ch: 'R', color: 'cyan' }
    case 'U':
      return { ch: 'U', color: 'red', bold: true }
  }
}

const GIT_MARKS = 'MA?DRU'

/** A row's flags, parsed. */
type Flags = { isDir: boolean; isOpen: boolean; hasChanges: boolean; isTouched: boolean; mark: GitMark | undefined }

function parseFlags(flags: string): Flags {
  let mark: GitMark | undefined
  for (const ch of flags) if (GIT_MARKS.includes(ch)) mark = ch as GitMark
  return {
    isDir: flags.includes('d'),
    isOpen: flags.includes('o'),
    hasChanges: flags.includes('c'),
    isTouched: flags.includes('t'),
    mark,
  }
}

// ------------------------------------------------------------ tree geometry

/** The most recent props, for listeners registered once. */
let latestProps: NavProps | undefined
/** The most recent state (adopted or committed), for listeners registered once. */
let liveState: NavState | undefined

/** Rows the tree window shows: the region less the `… N more` line when rows were left out. */
function viewRows(props: NavProps): number {
  const reserve = props.tree && props.tree.more > 0 ? 1 : 0
  return Math.max(1, props.rows - reserve)
}

/** Scroll so row `idx` is within the window; also clamps to the list. */
function fitTop(top: number, idx: number, window: number, total: number): number {
  let t = Math.min(top, Math.max(0, total - window))
  if (idx >= 0) {
    if (idx < t) t = idx
    else if (idx >= t + window) t = idx - window + 1
  }
  return Math.max(0, t)
}

function indexOfPath(rows: readonly NavRow[], path: string): number {
  if (path === '') return -1
  for (let i = 0; i < rows.length; i++) if (rows[i]![0] === path) return i
  return -1
}

/** The top the tree is drawn from, for these state and props. */
function topFor(state: NavState, props: NavProps): number {
  const rows = props.tree?.rows ?? []
  return fitTop(state.top, indexOfPath(rows, state.cursor), viewRows(props), rows.length)
}

// ------------------------------------------------------------------ adoption

function fileSeenKey(props: NavProps): string {
  if (props.mode !== 'file' || !props.file) return ''
  return `${props.file.path}|${props.file.mtimeMs}|${props.lineAt}`
}

/**
 * Fold new props into the state. Returns the same object when there is nothing
 * to adopt, so the caller calls setState only when something changed.
 */
function adopt(state: NavState | undefined, props: NavProps): NavState {
  let next: NavState
  if (state === undefined) {
    next = {
      cursor: props.cursor,
      cursorAt: props.cursorAt,
      top: 0,
      file: undefined,
      lastProps: props,
      fileSeen: '',
    }
    next.top = topFor(next, props)
  } else {
    next = state
    // The hooks side moved the cursor (reveal, follow, hotkeys): take it and scroll it into view.
    if (props.cursorAt !== next.cursorAt) {
      const moved: NavState = { ...next, cursor: props.cursor, cursorAt: props.cursorAt, lastProps: props }
      moved.top = topFor(moved, props)
      next = moved
    }
  }

  // The open file: create or refresh the file state once per (path, mtime, line bump).
  const seen = fileSeenKey(props)
  if (seen !== next.fileSeen) {
    const previous = next.file
    const isDirty = !!previous?.buffer?.isDirty
    if (seen === '') {
      // Left file mode. A dirty buffer is never thrown away by the tree coming back.
      next = { ...next, fileSeen: '', file: isDirty ? previous : undefined, lastProps: props }
    } else if (isDirty && previous && props.file && previous.path !== props.file.path) {
      // Never switch away from unsaved edits.
      next = { ...next, fileSeen: seen, lastProps: props }
    } else {
      let file = initFile(props, previous)
      // Same file with unsaved edits: the buffer survives whatever initFile did.
      if (isDirty && previous && file.path === previous.path && !file.buffer?.isDirty) file = previous
      next = { ...next, fileSeen: seen, file, lastProps: props }
    }
  }
  return next
}

// ----------------------------------------------------------------- the rows

/** One styled run of a drawn line. */
type Run = { s: string; color?: string; bold?: boolean; dim?: boolean; strike?: boolean }

const sameStyle = (a: Run, b: Run): boolean =>
  a.color === b.color && a.bold === b.bold && a.dim === b.dim && a.strike === b.strike

/** Merge neighbours of one style so a row stays a handful of nodes. */
function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (r.s === '') continue
    const last = out[out.length - 1]
    if (last && sameStyle(last, r)) last.s += r.s
    else out.push({ ...r })
  }
  return out
}

/** Width of the right-hand marker cluster (`● M`) plus one gap cell. */
const MARKER_CELLS = 3
const MARKER_GAP = 1

/** The styled runs of one tree row, exactly `W` cells wide. */
function rowRuns(row: NavRow, W: number, isFilter: boolean): Run[] {
  const [path, depth, flagText, matches] = row
  const f = parseFlags(flagText)
  const isDeleted = f.mark === 'D'
  const mark = !f.isDir && f.mark ? markOf(f.mark) : undefined
  const hasDirDot = f.isDir && f.hasChanges
  const hasMarker = (!!mark || hasDirDot || f.isTouched) && W >= 14
  const room = hasMarker ? W - MARKER_CELLS - MARKER_GAP : W

  // Left side: one gutter cell, indent, chevron, name.
  let prefix = ' '
  if (!isFilter) {
    prefix += ' '.repeat(Math.min(depth * 2, Math.max(0, Math.floor(room / 2))))
    prefix += f.isDir ? (f.isOpen ? '▾ ' : '▸ ') : '  '
  } else if (f.isDir) {
    prefix += f.isOpen ? '▾ ' : '▸ '
  }
  const prefixW = strWidth(prefix)
  const nameRoom = Math.max(1, room - prefixW)

  let name: string
  if (isFilter) name = path
  else {
    const slash = path.lastIndexOf('/')
    name = (slash >= 0 ? path.slice(slash + 1) : path) + (f.isDir ? '/' : '')
  }
  const raw = glyphsOf(name, isFilter ? matches : undefined)
  const glyphs = isFilter ? cutMiddle(raw, nameRoom) : cutEnd(raw, nameRoom)

  const runs: Run[] = [{ s: prefix, dim: isFilter && f.isDir }]
  for (const g of glyphs) {
    if (isDeleted) runs.push({ s: g.s, color: 'red', strike: true, dim: true })
    else if (g.hit) runs.push({ s: g.s, color: 'cyan', bold: true })
    else runs.push({ s: g.s, dim: isFilter && f.isDir })
  }

  const used = prefixW + sumWidth(glyphs)
  if (hasMarker) {
    runs.push({ s: ' '.repeat(Math.max(0, W - MARKER_CELLS - used)) })
    runs.push(f.isTouched ? { s: '●', color: 'magenta' } : { s: ' ' })
    runs.push({ s: ' ' })
    if (mark) runs.push({ s: mark.ch, color: mark.color, dim: mark.dim, bold: mark.bold })
    else if (hasDirDot) runs.push({ s: '•', dim: true })
    else runs.push({ s: ' ' })
  } else {
    runs.push({ s: ' '.repeat(Math.max(0, W - used)) })
  }
  return mergeRuns(runs)
}

function renderTree(surface: ClientSurface<NavState>, state: NavState, props: NavProps): RenderElement {
  const { Box, Text } = surface.elements
  const W = Math.max(1, props.columns)
  const tree = props.tree

  if (!tree) return <Text dimColor>Loading files…</Text>
  if (tree.rows.length === 0) {
    const msg = tree.isFiltering ? `No files match "${tree.query}"` : 'No files in this repo.'
    return (
      <Text dimColor wrap="truncate-end">
        {fit(msg, W)}
      </Text>
    )
  }

  const window = viewRows(props)
  const top = topFor(state, props)
  const end = Math.min(tree.rows.length, top + window)
  const lines: RenderElement[] = []
  for (let i = top; i < end; i++) {
    const row = tree.rows[i]!
    const isCursor = row[0] === state.cursor
    const runs = rowRuns(row, W, tree.isFiltering)
    lines.push(
      <Text key={`r:${row[0]}`} wrap="truncate-end" inverse={isCursor}>
        {runs.map(r => (
          <Text color={r.color} bold={r.bold} dimColor={r.dim} strikethrough={r.strike}>
            {r.s}
          </Text>
        ))}
      </Text>,
    )
  }
  // Rows left out of the props: say so once the window reaches the end.
  if (tree.more > 0 && end >= tree.rows.length) {
    lines.push(
      <Text key="more" dimColor wrap="truncate-end">
        {fit(` … ${tree.more.toLocaleString('en-US')} more`, W)}
      </Text>,
    )
  }
  return <Box flexDirection="column">{lines}</Box>
}

// -------------------------------------------------------------- tree input

/** Page size: a screen less one row of overlap. */
const pageOf = (props: NavProps): number => Math.max(1, viewRows(props) - 1)

/** The nearest row above `idx` that is a directory one level up, or -1. */
function parentIndex(rows: readonly NavRow[], idx: number): number {
  const depth = rows[idx]![1]
  if (depth <= 0) return -1
  for (let i = idx - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r[1] === depth - 1 && r[2].includes('d')) return i
    if (r[1] < depth - 1) return -1
  }
  return -1
}

/** Key names the Client receives that are not typed text. */
const SPECIAL_KEYS = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'home', 'end',
  'pageup', 'pagedown', 'escape', 'esc', 'insert', 'backtab', 'clear',
])

/** Text the person typed (a character, or a paste), as opposed to a key with a name. */
export function typedText(k: ClientKeyEvent): string | undefined {
  if (k.ctrl || k.meta || k.key === '' || SPECIAL_KEYS.has(k.key) || /^f\d+$/.test(k.key)) return undefined
  return k.key === 'space' ? ' ' : k.key
}

/** What a tree key does: the new state and the one op to post (either may be absent).
 * Only named keys navigate; typed text goes to Claude Code's prompt, and ← at the top level hands the keys back. */
function treeKey(state: NavState, k: ClientKeyEvent, props: NavProps): { state: NavState; op?: NavOp } {
  const text = typedText(k)
  if (text !== undefined) return { state, op: { op: 'type', text } }
  const tree = props.tree
  if (k.ctrl || k.meta) return { state }
  if (!tree || tree.rows.length === 0) return k.key === 'left' ? { state, op: { op: 'leave' } } : { state }
  const rows = tree.rows
  const idx = indexOfPath(rows, state.cursor)
  const cur = idx >= 0 ? rows[idx]! : undefined
  const f = cur ? parseFlags(cur[2]) : undefined

  /** Move the highlight to row `to`. */
  const move = (to: number): { state: NavState; op?: NavOp } => {
    const at = Math.max(0, Math.min(rows.length - 1, to))
    const path = rows[at]![0]
    if (path === state.cursor) return { state }
    const moved: NavState = { ...state, cursor: path }
    moved.top = fitTop(topFor(state, props), at, viewRows(props), rows.length)
    return { state: moved, op: { op: 'cursor', path } }
  }

  switch (k.key) {
    case 'up':
      return idx < 0 ? move(0) : move(idx - 1)
    case 'down':
      return idx < 0 ? move(0) : move(idx + 1)
    case 'pageup':
      return move((idx < 0 ? 0 : idx) - pageOf(props))
    case 'pagedown':
      return move((idx < 0 ? 0 : idx) + pageOf(props))
    case 'home':
      return move(0)
    case 'end':
      return move(rows.length - 1)
    case 'right': {
      if (!cur || !f) return move(0)
      if (!f.isDir) return { state, op: { op: 'open', path: cur[0] } }
      if (!f.isOpen) return { state, op: { op: 'expand', path: cur[0] } }
      const next = rows[idx + 1]
      // An expanded dir's first child is the next row, one level deeper.
      if (next && next[1] === cur[1] + 1) return move(idx + 1)
      return { state }
    }
    case 'left': {
      if (!cur || !f) return { state, op: { op: 'leave' } }
      if (f.isDir && f.isOpen) return { state, op: { op: 'collapse', path: cur[0] } }
      const parent = parentIndex(rows, idx)
      // At the repo's top level there is nowhere further out: back to Claude Code's prompt.
      return parent >= 0 ? move(parent) : { state, op: { op: 'leave' } }
    }
    case 'return':
    case 'enter':
      if (!cur || !f) return move(0)
      return { state, op: { op: f.isDir ? 'toggle' : 'open', path: cur[0] } }
  }
  return { state }
}

function treePointer(state: NavState, p: ClientPointerEvent, props: NavProps): { state: NavState; op?: NavOp } {
  const tree = props.tree
  if (p.type !== 'down' || !tree) return { state }
  if (p.y < 0 || p.y >= viewRows(props)) return { state }
  const at = topFor(state, props) + p.y
  const row = tree.rows[at]
  if (!row) return { state }
  const f = parseFlags(row[2])
  // A press on the row already selected acts on it (second click); otherwise it selects.
  if (row[0] === state.cursor) return { state, op: { op: f.isDir ? 'toggle' : 'open', path: row[0] } }
  return { state: { ...state, cursor: row[0], top: topFor(state, props) }, op: { op: 'cursor', path: row[0] } }
}

// ------------------------------------------------------------------ the Client

export default function Nav(props: NavProps, surface: ClientSurface<NavState>): RenderElement {
  latestProps = props

  // Adopt new props into the state: once on init, then once per change.
  const isFirst = surface.state === undefined
  const state = adopt(surface.state, props)
  if (state !== surface.state) surface.setState(state)
  liveState = state

  // Listeners are registered once, while the instance has no state yet. They read the live
  // state and props: `commit` keeps `liveState` current between a press and the next render.
  if (isFirst) {
    const commit = (next: NavState) => {
      liveState = next
      surface.setState(next)
    }
    surface.onKey(k => {
      const st = liveState
      const pr = latestProps
      if (!st || !pr) return
      if (pr.mode === 'file') {
        if (!st.file) return
        let posted: NavOp | undefined
        const file = fileKey(st.file, k, pr, op => {
          posted = op
        })
        if (file !== st.file) commit({ ...st, file })
        if (posted) surface.post(posted)
        return
      }
      const r = treeKey(st, k, pr)
      if (r.state !== st) commit(r.state)
      if (r.op) surface.post(r.op)
    })
    surface.onPointer(p => {
      const st = liveState
      const pr = latestProps
      if (!st || !pr) return
      if (pr.mode === 'file') {
        if (!st.file) return
        let posted: NavOp | undefined
        const file = filePointer(st.file, p, pr, op => {
          posted = op
        })
        if (file !== st.file) commit({ ...st, file })
        if (posted) surface.post(posted)
        return
      }
      const r = treePointer(st, p, pr)
      if (r.state !== st) commit(r.state)
      if (r.op) surface.post(r.op)
    })
  }

  const { Text } = surface.elements
  if (props.mode === 'file') {
    if (!state.file) return <Text dimColor>Loading…</Text>
    return fileRender(surface.elements, state.file, props)
  }
  return renderTree(surface, state, props)
}
