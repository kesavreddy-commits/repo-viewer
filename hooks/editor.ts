// Pure text-editing buffer for repo-viewer's in-pane editor. No I/O, no JSX, no DOM.
// Everything is immutable: every function returns new objects and never mutates its input.

export const TAB_WIDTH = 4

/** col is a UTF-16 index into the line. */
export type Pos = { row: number; col: number }
export type Snapshot = { lines: string[]; cursor: Pos }

type Run = { kind: 'ins' | 'bs' | 'del'; at: Pos }

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
  // Extras (not part of the contract, but harmless to read):
  /** The text the buffer was created from; isDirty is `toText(b) !== original`. */
  original: string
  /** What tab inserts: '\t', or two/four spaces, detected in fromText. */
  indent: string
  /** The last edit, while it can still be extended by the next keystroke (undo coalescing). */
  run?: Run
}

export type EditKey = { key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }

const UNDO_CAP = 200

// ---------------------------------------------------------------------------------------------
// Character widths
// ---------------------------------------------------------------------------------------------

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}
function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

/** Width in terminal cells of one code point (tab handled by the caller). */
function cpWidth(cp: number): number {
  if (cp === 0x0d) return 0
  if (cp < 0x20 || cp === 0x7f) return 1 // shown as a placeholder
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Code point at UTF-16 index i, and its UTF-16 length. */
function cpAt(s: string, i: number): [number, number] {
  const c = s.charCodeAt(i)
  if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
    return [s.codePointAt(i)!, 2]
  }
  return [c, 1]
}

/** Display column of UTF-16 index `col` in `line`; tabs advance to the next TAB_WIDTH stop. */
export function displayCol(line: string, col: number): number {
  const end = Math.min(col, line.length)
  let dc = 0
  let i = 0
  while (i < end) {
    const [cp, n] = cpAt(line, i)
    dc += cp === 0x09 ? TAB_WIDTH - (dc % TAB_WIDTH) : cpWidth(cp)
    i += n
  }
  return dc
}

/** The UTF-16 index whose display column is the largest one <= target (never inside a char). */
function colFromDisplay(line: string, target: number): number {
  let dc = 0
  let i = 0
  while (i < line.length) {
    const [cp, n] = cpAt(line, i)
    const w = cp === 0x09 ? TAB_WIDTH - (dc % TAB_WIDTH) : cpWidth(cp)
    if (dc + w > target) return i
    dc += w
    i += n
  }
  return line.length
}

/** Length (1 or 2) of the code point ending at index col (col > 0). */
function stepBack(line: string, col: number): number {
  return col >= 2 && isLow(line.charCodeAt(col - 1)) && isHigh(line.charCodeAt(col - 2)) ? 2 : 1
}
/** Length (1 or 2) of the code point starting at index col (col < line.length). */
function stepFwd(line: string, col: number): number {
  return cpAt(line, col)[1]
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

function detectIndent(lines: string[]): string {
  let spaces = 0
  let tabs = 0
  let minSpaces = Infinity
  const steps = new Map<number, number>()
  let prev = 0 // leading spaces of the previous non-blank line
  for (const l of lines) {
    if (l.trim() === '') continue
    let n = 0
    while (l[n] === ' ') n++
    if (l[0] === '\t') tabs++
    else if (n > 0) {
      spaces++
      if (n < minSpaces) minSpaces = n
      if (n > prev) steps.set(n - prev, (steps.get(n - prev) ?? 0) + 1)
    }
    prev = n
  }
  if (spaces === 0 || spaces <= tabs) return '\t'
  const two = steps.get(2) ?? 0
  const four = steps.get(4) ?? 0
  if (four > two) return '    '
  if (two > four) return '  '
  return minSpaces >= 4 ? '    ' : '  '
}

export function fromText(text: string, cursorRow = 0): Buffer {
  const lines = text.split('\n')
  const row = Math.max(0, Math.min(lines.length - 1, Math.floor(cursorRow) || 0))
  return {
    lines,
    cursor: { row, col: 0 },
    goalCol: 0,
    top: 0,
    left: 0,
    isDirty: false,
    undo: [],
    redo: [],
    original: text,
    indent: detectIndent(lines),
  }
}

export function toText(b: Buffer): string {
  return b.lines.join('\n')
}

function isSameText(lines: string[], original: string): boolean {
  return lines.join('\n') === original
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

const posEq = (a: Pos, b: Pos): boolean => a.row === b.row && a.col === b.col

function line(b: Buffer, row: number): string {
  return b.lines[row] ?? ''
}

/** A cursor move: no text change, ends any coalescing run. */
function moved(b: Buffer, cursor: Pos, keepGoal: boolean): Buffer {
  return {
    ...b,
    cursor,
    goalCol: keepGoal ? b.goalCol : displayCol(line(b, cursor.row), cursor.col),
    run: undefined,
  }
}

/** A text change. `kind` lets consecutive edits of the same kind share one undo step. */
function commit(b: Buffer, lines: string[], cursor: Pos, kind?: Run['kind']): Buffer {
  const continuing = kind !== undefined && b.run !== undefined && b.run.kind === kind && posEq(b.run.at, b.cursor)
  let undo = b.undo
  if (!continuing) {
    undo = [...b.undo, { lines: b.lines, cursor: b.cursor }]
    if (undo.length > UNDO_CAP) undo = undo.slice(undo.length - UNDO_CAP)
  }
  return {
    ...b,
    lines,
    cursor,
    goalCol: displayCol(lines[cursor.row] ?? '', cursor.col),
    isDirty: !isSameText(lines, b.original),
    undo,
    redo: [],
    run: kind ? { kind, at: cursor } : undefined,
  }
}

function replaceLine(lines: string[], row: number, text: string): string[] {
  const out = lines.slice()
  out[row] = text
  return out
}

function insertText(b: Buffer, text: string): Buffer {
  const { row, col } = b.cursor
  const cur = line(b, row)
  const before = cur.slice(0, col)
  const after = cur.slice(col)
  const parts = text.split(/\r\n|\r|\n/)
  if (parts.length === 1) {
    const kind = text.length > 0 && !/[\s\p{P}\p{S}]/u.test(text) ? 'ins' : undefined
    return commit(b, replaceLine(b.lines, row, before + text + after), { row, col: col + text.length }, kind)
  }
  const last = parts[parts.length - 1]!
  const mid = parts.slice(1, -1)
  const first = before + parts[0]!
  const newLines = [...b.lines.slice(0, row), first, ...mid, last + after, ...b.lines.slice(row + 1)]
  return commit(b, newLines, { row: row + parts.length - 1, col: last.length })
}

function newline(b: Buffer): Buffer {
  const { row, col } = b.cursor
  const cur = line(b, row)
  const lead = /^[ \t]*/.exec(cur)![0].slice(0, col)
  const newLines = [...b.lines.slice(0, row), cur.slice(0, col), lead + cur.slice(col), ...b.lines.slice(row + 1)]
  return commit(b, newLines, { row: row + 1, col: lead.length })
}

function backspace(b: Buffer): Buffer {
  const { row, col } = b.cursor
  const cur = line(b, row)
  if (col > 0) {
    const n = stepBack(cur, col)
    return commit(b, replaceLine(b.lines, row, cur.slice(0, col - n) + cur.slice(col)), { row, col: col - n }, 'bs')
  }
  if (row === 0) return b
  const prev = line(b, row - 1)
  const newLines = [...b.lines.slice(0, row - 1), prev + cur, ...b.lines.slice(row + 1)]
  return commit(b, newLines, { row: row - 1, col: prev.length }, 'bs')
}

function del(b: Buffer): Buffer {
  const { row, col } = b.cursor
  const cur = line(b, row)
  if (col < cur.length) {
    const n = stepFwd(cur, col)
    return commit(b, replaceLine(b.lines, row, cur.slice(0, col) + cur.slice(col + n)), b.cursor, 'del')
  }
  if (row >= b.lines.length - 1) return b
  const newLines = [...b.lines.slice(0, row), cur + line(b, row + 1), ...b.lines.slice(row + 2)]
  return commit(b, newLines, b.cursor, 'del')
}

function killToEnd(b: Buffer): Buffer {
  const { row, col } = b.cursor
  const cur = line(b, row)
  if (col < cur.length) return commit(b, replaceLine(b.lines, row, cur.slice(0, col)), b.cursor)
  return del(b) // at end of line: join the next line (no run coalescing)
}

function killToStart(b: Buffer): Buffer {
  const { row, col } = b.cursor
  if (col === 0) return b
  const cur = line(b, row)
  return commit(b, replaceLine(b.lines, row, cur.slice(col)), { row, col: 0 })
}

function dedent(b: Buffer): Buffer {
  const { row, col } = b.cursor
  const cur = line(b, row)
  let n = 0
  if (cur[0] === '\t') n = 1
  else {
    const max = b.indent === '\t' ? 4 : b.indent.length
    while (n < max && cur[n] === ' ') n++
  }
  if (n === 0) return b
  return commit(b, replaceLine(b.lines, row, cur.slice(n)), { row, col: Math.max(0, col - n) })
}

function wordClass(s: string): 0 | 1 | 2 {
  if (/\s/u.test(s)) return 0
  if (/[\p{L}\p{N}_]/u.test(s)) return 1
  return 2
}

function wordLeft(b: Buffer): Pos {
  const { row, col } = b.cursor
  if (col === 0) return row > 0 ? { row: row - 1, col: line(b, row - 1).length } : b.cursor
  const cur = line(b, row)
  let c = col
  const at = (i: number): number => wordClass(cur.slice(i - stepBack(cur, i), i))
  while (c > 0 && at(c) === 0) c -= stepBack(cur, c)
  if (c > 0) {
    const cls = at(c)
    while (c > 0 && at(c) === cls) c -= stepBack(cur, c)
  }
  return { row, col: c }
}

function wordRight(b: Buffer): Pos {
  const { row, col } = b.cursor
  const cur = line(b, row)
  if (col >= cur.length) return row < b.lines.length - 1 ? { row: row + 1, col: 0 } : b.cursor
  let c = col
  const at = (i: number): number => wordClass(cur.slice(i, i + stepFwd(cur, i)))
  while (c < cur.length && at(c) === 0) c += stepFwd(cur, c)
  if (c < cur.length) {
    const cls = at(c)
    while (c < cur.length && at(c) === cls) c += stepFwd(cur, c)
  }
  return { row, col: c }
}

function undoStep(b: Buffer): Buffer {
  const snap = b.undo[b.undo.length - 1]
  if (!snap) return moved(b, b.cursor, true)
  return {
    ...b,
    lines: snap.lines,
    cursor: snap.cursor,
    goalCol: displayCol(snap.lines[snap.cursor.row] ?? '', snap.cursor.col),
    isDirty: !isSameText(snap.lines, b.original),
    undo: b.undo.slice(0, -1),
    redo: [...b.redo, { lines: b.lines, cursor: b.cursor }],
    run: undefined,
  }
}

function redoStep(b: Buffer): Buffer {
  const snap = b.redo[b.redo.length - 1]
  if (!snap) return moved(b, b.cursor, true)
  return {
    ...b,
    lines: snap.lines,
    cursor: snap.cursor,
    goalCol: displayCol(snap.lines[snap.cursor.row] ?? '', snap.cursor.col),
    isDirty: !isSameText(snap.lines, b.original),
    undo: [...b.undo, { lines: b.lines, cursor: b.cursor }],
    redo: b.redo.slice(0, -1),
    run: undefined,
  }
}

function moveRows(b: Buffer, delta: number): Buffer {
  const { row } = b.cursor
  const target = row + delta
  if (target < 0) return moved(b, { row: 0, col: 0 }, false)
  if (target > b.lines.length - 1) {
    return moved(b, { row: b.lines.length - 1, col: line(b, b.lines.length - 1).length }, false)
  }
  return moved(b, { row: target, col: colFromDisplay(line(b, target), b.goalCol) }, true)
}

// Named keys that are not text. Other multi-char keys are pasted text.
const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown',
  'escape', 'esc', 'insert', 'backtab', 'clear',
])

/** Apply one key; returns the new buffer (never mutates). Cursor moves do not scroll: call scrollIntoView. */
export function applyKey(b: Buffer, k: EditKey, viewRows: number): Buffer {
  const key = k.key
  const mod = !!(k.ctrl || k.meta)
  const rows = Math.max(1, Math.floor(viewRows) || 1)

  if (k.ctrl && !k.meta) {
    switch (key.toLowerCase()) {
      case 'z':
        return k.shift ? redoStep(b) : undoStep(b)
      case 'y':
        return redoStep(b)
      case 'k':
        return killToEnd(b)
      case 'u':
        return killToStart(b)
    }
  }

  switch (key) {
    case 'up':
      return mod ? b : moveRows(b, -1)
    case 'down':
      return mod ? b : moveRows(b, 1)
    case 'left':
      if (mod) return moved(b, wordLeft(b), false)
      if (b.cursor.col > 0) {
        return moved(b, { row: b.cursor.row, col: b.cursor.col - stepBack(line(b, b.cursor.row), b.cursor.col) }, false)
      }
      return b.cursor.row > 0 ? moved(b, { row: b.cursor.row - 1, col: line(b, b.cursor.row - 1).length }, false) : moved(b, b.cursor, false)
    case 'right': {
      if (mod) return moved(b, wordRight(b), false)
      const cur = line(b, b.cursor.row)
      if (b.cursor.col < cur.length) return moved(b, { row: b.cursor.row, col: b.cursor.col + stepFwd(cur, b.cursor.col) }, false)
      return b.cursor.row < b.lines.length - 1 ? moved(b, { row: b.cursor.row + 1, col: 0 }, false) : moved(b, b.cursor, false)
    }
    case 'home':
      if (k.ctrl) return moved(b, { row: 0, col: 0 }, false)
      return moved(b, { row: b.cursor.row, col: 0 }, false)
    case 'end':
      if (k.ctrl) {
        const last = b.lines.length - 1
        return moved(b, { row: last, col: line(b, last).length }, false)
      }
      return moved(b, { row: b.cursor.row, col: line(b, b.cursor.row).length }, false)
    case 'pageup':
    case 'pagedown': {
      if (mod) return b
      const delta = key === 'pageup' ? -rows : rows
      const next = moveRows(b, delta)
      const maxTop = Math.max(0, b.lines.length - 1)
      return { ...next, top: Math.max(0, Math.min(maxTop, b.top + delta)) }
    }
    case 'return':
    case 'enter':
      return mod ? b : newline(b)
    case 'backspace':
      return mod ? b : backspace(b)
    case 'delete':
      return mod ? b : del(b)
    case 'tab':
      if (mod) return b
      return k.shift ? dedent(b) : commit(b, ...tabArgs(b))
    case 'escape':
    case 'esc':
    case 'insert':
    case 'backtab':
    case 'clear':
      return b
  }

  if (mod) return b // unhandled ctrl/meta combo: never insert the letter
  if (key.length === 0 || NAMED.has(key) || /^f\d{1,2}$/.test(key)) return b
  if (key.charCodeAt(0) === 0x1b) return b
  return insertText(b, key === 'space' ? ' ' : key)
}

function tabArgs(b: Buffer): [string[], Pos] {
  const { row, col } = b.cursor
  const cur = line(b, row)
  return [replaceLine(b.lines, row, cur.slice(0, col) + b.indent + cur.slice(col)), { row, col: col + b.indent.length }]
}

// ---------------------------------------------------------------------------------------------
// Scrolling and viewing
// ---------------------------------------------------------------------------------------------

/** Scroll minimally so the cursor is visible in a viewRows x viewCols window (gutter excluded). */
export function scrollIntoView(b: Buffer, viewRows: number, viewCols: number): Buffer {
  const rows = Math.max(1, Math.floor(viewRows) || 1)
  const cols = Math.max(1, Math.floor(viewCols) || 1)
  let top = Math.max(0, b.top)
  const { row } = b.cursor
  if (row < top) top = row
  else if (row >= top + rows) top = row - rows + 1
  top = Math.max(0, top)

  const dc = displayCol(line(b, row), b.cursor.col)
  let left = Math.max(0, b.left)
  if (dc < left) left = dc
  else if (dc >= left + cols) left = dc - cols + 1
  left = Math.max(0, left)

  return top === b.top && left === b.left ? b : { ...b, top, left }
}

/** Display string of a line (tabs expanded, control chars replaced), as per-cell strings. */
function cells(text: string): { s: string; w: number }[] {
  const out: { s: string; w: number }[] = []
  let dc = 0
  let i = 0
  while (i < text.length) {
    const [cp, n] = cpAt(text, i)
    if (cp === 0x09) {
      const w = TAB_WIDTH - (dc % TAB_WIDTH)
      for (let j = 0; j < w; j++) out.push({ s: ' ', w: 1 })
      dc += w
    } else if (cp === 0x0d) {
      // zero width, not drawn
    } else if (cp < 0x20 || cp === 0x7f) {
      out.push({ s: '·', w: 1 })
      dc += 1
    } else {
      const w = cpWidth(cp)
      out.push({ s: text.slice(i, i + n), w })
      dc += w
    }
    i += n
  }
  return out
}

/** The visible window: rows from b.top, each cut to [left, left+viewCols) display columns. */
export function view(b: Buffer, viewRows: number, viewCols: number): { lineNo: number; text: string; cursorCol?: number }[] {
  const rows = Math.max(0, Math.floor(viewRows) || 0)
  const cols = Math.max(0, Math.floor(viewCols) || 0)
  const top = Math.max(0, b.top)
  const left = Math.max(0, b.left)
  const out: { lineNo: number; text: string; cursorCol?: number }[] = []
  for (let r = top; r < b.lines.length && r < top + rows; r++) {
    let text = ''
    let dc = 0
    for (const c of cells(b.lines[r]!)) {
      const start = dc
      dc += c.w
      if (c.w === 0) {
        if (start >= left && start < left + cols) text += c.s
        continue
      }
      if (start < left) {
        if (dc > left) text += ' '.repeat(dc - left) // wide char cut by the left edge
        continue
      }
      if (dc > left + cols) break
      text += c.s
    }
    const entry: { lineNo: number; text: string; cursorCol?: number } = { lineNo: r + 1, text }
    if (r === b.cursor.row) entry.cursorCol = displayCol(b.lines[r]!, b.cursor.col) - left
    out.push(entry)
  }
  return out
}
