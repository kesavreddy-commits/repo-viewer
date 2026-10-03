// File mode of canopy's keyboard Client (hooks/nav.tsx): the scrolling,
// syntax-highlighted file view with a line cursor, the rendered-markdown view, the diff
// view and the in-pane text editor UI.
//
// Everything here is pure: `fileKey`, `filePointer` and `initFile` return new FileState
// objects (nav.tsx keeps them in surface state) and `fileRender` only reads. The hooks side
// draws the header and toolbar above the Client, so this draws props.rows rows of at most
// props.columns cells: a body (rows - 1 lines) and one dim status line.
import type { ClientElements, ClientKeyEvent, ClientPointerEvent, RenderElement } from 'claude-code'

import type { NavFile, NavOp, NavProps } from '../types'
import { applyKey, displayCol, fromText, scrollIntoView, toText, view } from './editor'
import type { Buffer } from './editor'

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
  // Extras (optional, so nav.tsx need not know them):
  /** Diff: lines already scrolled off the top of the first visible hunk. */
  diffTop?: number
  /** The page the view state refers to (paged files): a change resets the cursor to the page's edge. */
  page?: number
  /** The `at` of the newest notice already seen; only a newer one is shown. */
  noticeAt?: number
  /** The first ctrl+q on a dirty buffer asked; the next one discards. */
  isDiscarding?: boolean
  /** The text of the save last posted: when the file on disk becomes it, the save landed. */
  saved?: string
}

/** Code.source and Markdown.text are refused above 10000 characters. */
const LIMIT = 10000
const BUDGET = 9500

// --------------------------------------------------------------------------- helpers

/** Strips what Code and Markdown refuse (control characters but tab and newline, incl. \r). */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** `abcdefgh` to `abcdefg…` within n characters. */
function cut(s: string, n: number): string {
  if (n <= 0) return ''
  if (s.length <= n) return s
  return n === 1 ? '…' : s.slice(0, n - 1) + '…'
}

/** Cuts at n UTF-16 units without splitting a surrogate pair. */
function slice(s: string, n: number): string {
  if (s.length <= n) return s
  const c = s.charCodeAt(n - 1)
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

let cachedText: string | undefined
let cachedLines: string[] = []

/** The lines of a text (a trailing newline does not make an extra line); memoised on the last text. */
function linesOf(text: string | undefined): string[] {
  if (text === undefined || text === '') return []
  if (text === cachedText) return cachedLines
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  cachedText = text
  cachedLines = lines

  return lines
}

const isTextual = (f: NavFile): boolean => f.kind === 'text' || f.kind === 'markdown'
const isRendered = (f: NavFile): boolean => f.kind === 'markdown' && !f.isRaw && !f.showDiff
const hasDiffView = (f: NavFile): boolean => f.showDiff && (isTextual(f) || f.kind === 'missing')

function dims(props: NavProps): { columns: number; rows: number; body: number } {
  const columns = Math.max(1, Math.floor(props.columns) || 1)
  const rows = Math.max(0, Math.floor(props.rows) || 0)

  return { columns, rows, body: Math.max(0, rows - 1) }
}

/** Gutter: marker, right-aligned number, space. None when the pane is too narrow. */
function gutter(maxLine: number, columns: number): { gw: number; digits: number } {
  const digits = Math.max(2, String(Math.max(1, maxLine)).length)
  const gw = digits + 2

  return columns >= gw + 8 ? { gw, digits } : { gw: 0, digits }
}

/** The file's line range: [start, last] (last < start when empty). */
function extent(f: NavFile): { start: number; lines: string[]; last: number } {
  const start = Math.max(1, Math.floor(f.startLine) || 1)
  const lines = linesOf(f.text)

  return { start, lines, last: start + lines.length - 1 }
}

// --------------------------------------------------------------------------- state

function blank(props: NavProps): FileState {
  return { path: props.file?.path ?? '', mtimeMs: props.file?.mtimeMs ?? 0, top: 1, line: 1, hunk: 0, isConflict: false, lineAt: props.lineAt }
}

/** The view fields kept inside the file and the cursor in the window. Returns `s` when nothing changes. */
function clampView(s: FileState, props: NavProps): FileState {
  const f = props.file
  if (!f || s.buffer) return s
  const { body } = dims(props)
  const h = Math.max(1, body)
  let { top, line, hunk } = s
  let diffTop = s.diffTop ?? 0
  if (hasDiffView(f)) {
    const hunks = parseHunks(f.diff?.hunks ?? '')
    hunk = clamp(hunk, 0, Math.max(0, hunks.length - 1))
    diffTop = clamp(diffTop, 0, Math.max(0, (hunks[hunk]?.length ?? 1) - 2))
  } else if (isTextual(f)) {
    const { start, last } = extent(f)
    const end = Math.max(start, last)
    if (isRendered(f)) {
      top = clamp(top, start, end)
      line = top
    } else {
      line = clamp(line, start, end)
      if (line < top) top = line
      else if (line >= top + h) top = line - h + 1
      top = clamp(top, start, Math.max(start, end - h + 1))
    }
  }
  if (top === s.top && line === s.line && hunk === s.hunk && diffTop === (s.diffTop ?? 0)) return s

  return { ...s, top, line, hunk, diffTop }
}

/** New props for the same file while a buffer is open: the external-change rules. */
function reconcileBuffer(s: FileState, f: NavFile, props: NavProps): FileState {
  let n = s
  const b = s.buffer!
  const note = props.notice
  if (note && note.tone === 'warn' && /changed/i.test(note.text) && note.at > (n.noticeAt ?? 0)) {
    n = { ...n, isConflict: true, noticeAt: note.at }
  }
  if (f.mtimeMs > s.mtimeMs) {
    const text = f.text
    if (text === undefined) {
      n = b.isDirty ? { ...n, isConflict: true } : { ...n, mtimeMs: f.mtimeMs }
    } else if (text === toText(b) || text === s.saved) {
      // The save landed (or the file now equals the buffer): clean, and the new mtime is the base.
      n = { ...n, mtimeMs: f.mtimeMs, isConflict: false, saved: undefined, buffer: { ...b, original: text, isDirty: toText(b) !== text } }
    } else if (!b.isDirty) {
      const nb = fromText(text, b.cursor.row)
      const row = nb.cursor.row
      const col = Math.min(b.cursor.col, (nb.lines[row] ?? '').length)
      n = {
        ...n,
        mtimeMs: f.mtimeMs,
        isConflict: false,
        buffer: { ...nb, cursor: { row, col }, goalCol: displayCol(nb.lines[row] ?? '', col), top: b.top, left: b.left },
      }
    } else {
      n = { ...n, isConflict: true }
    }
  }

  return n
}

/** Brings state up to date with props: the file switched, the page changed, the hooks side moved the line, the file changed on disk. */
function sync(s: FileState, props: NavProps): FileState {
  const f = props.file
  if (!f) return s
  if (f.path !== s.path && !s.buffer?.isDirty) return initFile(props)
  if (f.path !== s.path) return s
  let n = s
  if (n.buffer) {
    if (props.lineAt !== n.lineAt) n = { ...n, lineAt: props.lineAt }
    n = reconcileBuffer(n, f, props)
  } else {
    const { body } = dims(props)
    if (n.page !== undefined && n.page !== f.page) {
      const { start, last } = extent(f)
      n =
        f.page > n.page
          ? { ...n, page: f.page, line: start, top: start }
          : { ...n, page: f.page, line: Math.max(start, last), top: Math.max(start, last - Math.max(1, body) + 1) }
    } else if (n.page === undefined) {
      n = { ...n, page: f.page }
    }
    if (props.lineAt !== n.lineAt) {
      n = { ...n, lineAt: props.lineAt }
      if (props.line !== undefined) n = { ...n, line: props.line, top: props.line - Math.floor(Math.max(1, body) / 3) }
    }
    if (f.mtimeMs !== n.mtimeMs) n = { ...n, mtimeMs: f.mtimeMs }
  }

  return n
}

function settle(s: FileState, props: NavProps): FileState {
  return clampView(sync(s, props), props)
}

/** Call when the open file or its mtime changes (nav.tsx), or with nothing to start. Keeps the view and an open buffer for the same path. */
export function initFile(props: NavProps, previous?: FileState): FileState {
  const f = props.file
  if (!f) return blank(props)
  if (previous && previous.path === f.path) {
    return clampView(sync({ ...previous, mtimeMs: previous.buffer ? previous.mtimeMs : f.mtimeMs }, props), props)
  }
  const { body } = dims(props)
  const start = Math.max(1, Math.floor(f.startLine) || 1)
  let line = start
  let top = start
  if (props.line !== undefined) {
    line = props.line
    top = line - Math.floor(Math.max(1, body) / 3)
  }

  return clampView(
    {
      path: f.path,
      mtimeMs: f.mtimeMs,
      top,
      line,
      hunk: 0,
      isConflict: false,
      lineAt: props.lineAt,
      diffTop: 0,
      page: f.page,
      noticeAt: props.notice?.at ?? 0,
    },
    props,
  )
}

/** The state as fileKey would see it for these props (file switched, page turned, external change applied). nav.tsx may call it to persist what render derived. */
export function syncFile(state: FileState, props: NavProps): FileState {
  return settle(state, props)
}

// --------------------------------------------------------------------------- diff

type Hunk = string[]

/** Splits `git diff` hunks into hunks (each starting with its `@@` header); what precedes the first one is dropped. */
function parseHunks(text: string): Hunk[] {
  if (text === '') return []
  const out: Hunk[] = []
  let cur: Hunk | undefined
  for (const raw of text.split('\n')) {
    const line = clean(raw)
    if (line.startsWith('@@')) {
      cur = [line]
      out.push(cur)
    } else if (cur) {
      cur.push(line)
    }
  }
  if (cur && cur.length > 1 && cur[cur.length - 1] === '') cur.pop()

  return out
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** A hunk from its header (start lines kept, counts recomputed from the body so a cut hunk still parses) and body lines. */
function buildHunk(header: string, body: string[], oldSkip = 0, newSkip = 0): string[] {
  const m = HEADER.exec(header)
  if (!m) return [header, ...body]
  let oldN = 0
  let newN = 0
  for (const l of body) {
    const c = l.charAt(0)
    if (c === '\\') continue
    if (c !== '+') oldN++
    if (c !== '-') newN++
  }
  const a = Number(m[1]) + oldSkip
  const c = Number(m[2]) + newSkip

  return [`@@ -${a},${oldN} +${c},${newN} @@${m[3] ?? ''}`, ...body]
}

/** The hunk with its first `skip` body lines scrolled off, header renumbered. */
function skipLines(hunk: Hunk, skip: number): string[] {
  const header = hunk[0] ?? ''
  const body = hunk.slice(1)
  let i = 0
  let oldSkip = 0
  let newSkip = 0
  let counted = 0
  while (i < body.length && counted < skip) {
    const c = body[i]!.charAt(0)
    if (c !== '\\') {
      counted++
      if (c !== '+') oldSkip++
      if (c !== '-') newSkip++
    }
    i++
  }
  while (i < body.length && body[i]!.startsWith('\\')) i++

  return buildHunk(header, body.slice(i), oldSkip, newSkip)
}

/** The diff source drawn from hunk `from` (its first `skip` lines scrolled off): whole hunks within the 10000-character limit. */
function diffSource(hunks: Hunk[], from: number, skip: number): string {
  const out: string[] = []
  let chars = 0
  for (let h = from; h < hunks.length; h++) {
    let lines = h === from && skip > 0 ? skipLines(hunks[h]!, skip) : hunks[h]!
    lines = lines.map((l, i) => (i === 0 ? l : slice(l, 400)))
    let size = lines.reduce((n, l) => n + l.length + 1, 0)
    if (size > BUDGET - chars) {
      if (h !== from) break
      // The first hunk alone is too long: keep its leading lines, with the counts to match.
      const body: string[] = []
      let used = (lines[0]?.length ?? 0) + 40
      for (const l of lines.slice(1)) {
        if (used + l.length + 1 > BUDGET) break
        body.push(l)
        used += l.length + 1
      }
      lines = buildHunk(lines[0] ?? '', body)
      size = lines.reduce((n, l) => n + l.length + 1, 0)
    }
    out.push(...lines)
    chars += size
  }

  return out.join('\n')
}

// --------------------------------------------------------------------------- markdown

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** The fence opener line when line `idx` sits inside a fenced code block, else undefined. */
function fenceOpener(lines: string[], idx: number): string | undefined {
  let open: string | undefined
  let mark = ''
  for (let i = 0; i < idx && i < lines.length; i++) {
    const l = lines[i]!
    const m = FENCE.exec(l)
    if (!m) continue
    const run = m[1]!
    if (open === undefined) {
      if (run.charAt(0) === '`' && (m[2] ?? '').includes('`')) continue
      open = l
      mark = run
    } else if (run.charAt(0) === mark.charAt(0) && run.length >= mark.length && (m[2] ?? '').trim() === '') {
      open = undefined
    }
  }

  return open
}

/** The markdown source drawn from line `top`: enough lines to fill `body` rows (the Box clips the rest), within the limit. */
/** Rows a markdown source line is likely to take once rendered `columns` wide: wrapped prose, a
 * table row with its rule, a heading with its gap. An estimate that errs tall, since a Markdown that
 * outgrows its box overprints the rows below it in the terminal rather than clipping. */
function renderedRows(line: string, columns: number): number {
  const text = line.trim()
  if (text === '') return 1
  if (text.startsWith('|')) return 2
  if (/^#{1,6}\s/.test(text)) return 2
  return Math.max(1, Math.ceil((text.length + 4) / Math.max(10, columns - 2)))
}

function markdownSource(f: NavFile, top: number, body: number, columns: number): string {
  const { start, lines } = extent(f)
  const idx = clamp(top - start, 0, Math.max(0, lines.length - 1))
  const opener = fenceOpener(lines, idx)
  const out: string[] = []
  let chars = 0
  let rows = 0
  if (opener !== undefined) {
    out.push(clean(opener))
    chars += out[0]!.length + 1
    rows += 1
  }
  let inTable = false
  for (let i = idx; i < lines.length; i++) {
    const l = slice(clean(lines[i]!), 2000)
    const isRow = l.trim().startsWith('|')
    // A table's top border and header rule.
    const cost = renderedRows(l, columns) + (isRow && !inTable ? 2 : 0)
    if (rows + cost > body && out.length > 0) break
    // A table starts only if it fits whole (a cut one draws as an empty bordered row): else it
    // opens the next screen. One taller than the pane still draws, cut, when it is at the top.
    if (isRow && !inTable && out.length > 0) {
      let end = i
      while (end + 1 < lines.length && lines[end + 1]!.trim().startsWith('|')) end++
      const tableRows = 3 + (end - i + 1) * 2
      if (rows + tableRows > body) break
    }
    if (chars + l.length + 1 > BUDGET && out.length > 0) break
    inTable = isRow
    out.push(l)
    chars += l.length + 1
    rows += cost
  }
  // A fence left open would swallow nothing after it, but keeps the renderer from guessing.
  if (fenceOpener(out, out.length) !== undefined) out.push('```')

  return slice(out.join('\n'), LIMIT)
}

// --------------------------------------------------------------------------- status line

type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean }

const width = (segs: Seg[]): number => segs.reduce((n, s) => n + s.t.length, 0)

/** Cuts the segments to `cols` cells, with an ellipsis where it cut. */
function cutSegs(segs: Seg[], cols: number): Seg[] {
  if (width(segs) <= cols) return segs
  const out: Seg[] = []
  let left = cols
  for (const s of segs) {
    if (left <= 0) break
    if (s.t.length <= left) {
      out.push(s)
      left -= s.t.length
    } else {
      out.push({ ...s, t: cut(s.t, left) })
      break
    }
  }

  return out
}

/** The first candidate that fits `cols`, else the first one cut. */
function pick(cols: number, candidates: Seg[][]): Seg[] {
  for (const c of candidates) if (width(c) <= cols) return c

  return cutSegs(candidates[0] ?? [], cols)
}

const TONE: Record<string, string> = { info: 'green', warn: 'yellow', error: 'red' }

function freshNotice(s: FileState, props: NavProps): Seg[] {
  const n = props.notice
  if (!n || n.at <= (s.noticeAt ?? 0) || n.text === '') return []

  return [{ t: ' · ', dim: true }, { t: n.text, color: TONE[n.tone] ?? 'green' }]
}

/** `head hints · pos tail`, tried with each tail and, for each, with fewer hints (dropped from the right). */
function hintCandidates(head: Seg[], hints: string[], pos: string, tails: Seg[][]): Seg[][] {
  const out: Seg[][] = []
  for (const tail of tails) {
    for (let k = hints.length; k >= 0; k--) {
      const segs: Seg[] = [...head]
      if (k > 0) segs.push({ t: (segs.length > 0 ? ' ' : '') + hints.slice(0, k).join('  '), dim: true })
      if (pos !== '') segs.push({ t: (segs.length > 0 ? ' · ' : '') + pos, dim: true })
      segs.push(...tail)
      out.push(segs)
    }
  }

  return out
}

function renderStatus(el: ClientElements, segs: Seg[]): RenderElement {
  const { Text } = el

  return (
    <Text wrap="truncate-end">
      {' '}
      {segs.map(s => (
        <Text {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})}>
          {s.t}
        </Text>
      ))}
    </Text>
  )
}

function viewStatus(el: ClientElements, s: FileState, props: NavProps, columns: number): RenderElement {
  const f = props.file
  const notice = freshNotice(s, props)
  const tails: Seg[][] = notice.length > 0 ? [notice, []] : [[]]
  let hints: string[]
  let pos = ''
  if (!f) {
    hints = ['← back']
  } else if (hasDiffView(f)) {
    const hunks = parseHunks(f.diff?.hunks ?? '')
    hints = ['← file', '↑↓ hunk', 'pgdn more']
    if (hunks.length > 0) pos = `hunk ${s.hunk + 1}/${hunks.length}`
    if (f.diff?.isTruncated) tails.unshift([{ t: ' · diff truncated', dim: true }])
  } else if (isTextual(f)) {
    hints = ['← back']
    if (f.isEditable) hints.push('→ edit')
    hints.push('↑↓ move')
    if (f.pageCount > 1) hints.push(`page ${f.page + 1}/${f.pageCount}`)
    pos = `${isRendered(f) ? s.top : s.line}/${f.lineCount}`
  } else {
    hints = ['← back']
  }

  return renderStatus(el, pick(columns, hintCandidates([], hints, pos, tails)))
}

function editStatus(el: ClientElements, s: FileState, props: NavProps, columns: number): RenderElement {
  const b = s.buffer!
  const head: Seg[] = [{ t: 'EDIT', bold: true }]
  const mod: Seg[] = b.isDirty ? [{ t: ' ● modified', color: 'yellow' }] : []
  const pos = `${b.cursor.row + 1}:${displayCol(b.lines[b.cursor.row] ?? '', b.cursor.col) + 1}`
  const msg = s.isDiscarding
    ? { full: 'unsaved changes — ctrl+q again to discard', short: 'unsaved — ctrl+q again to discard' }
    : s.isConflict
      ? { full: 'changed on disk — ctrl+s overwrites', short: 'changed — ctrl+s overwrites' }
      : undefined
  let candidates: Seg[][]
  if (msg) {
    const m = (t: string): Seg => ({ t, color: 'yellow', bold: true })
    candidates = [
      [...head, { t: ' ' }, m(msg.full), { t: ' · ' + pos, dim: true }],
      [...head, { t: ' ' }, m(msg.full)],
      [m(msg.full)],
      [...head, { t: ' ' }, m(msg.short)],
      [m(msg.short)],
    ]
  } else {
    const notice = freshNotice(s, props)
    const tails: Seg[][] = []
    if (notice.length > 0) tails.push([...mod, ...notice])
    tails.push(mod, [])
    candidates = hintCandidates(head, ['ctrl+s save', 'ctrl+q done', 'ctrl+z undo'], pos, tails)
    candidates.push([...head, ...mod])
  }

  return renderStatus(el, pick(columns, candidates))
}

// --------------------------------------------------------------------------- drawing

/** A gutter cell: the cursor line's bright with a marker, the rest dim. */
function cell(el: ClientElements, n: number, digits: number, isCursor: boolean): RenderElement {
  const { Text } = el
  const num = String(n).padStart(digits)
  if (isCursor) {
    return (
      <Text wrap="truncate-end">
        <Text color="cyan">▸</Text>
        <Text bold>{num + ' '}</Text>
      </Text>
    )
  }

  return (
    <Text dimColor wrap="truncate-end">
      {' ' + num + ' '}
    </Text>
  )
}

function message(el: ClientElements, lines: string[], columns: number, body: number): RenderElement {
  const { Box, Text } = el

  return (
    <Box flexDirection="column" height={body} width={columns} flexShrink={0} overflow="hidden">
      {lines.slice(0, body).map(l => (
        <Text dimColor wrap="truncate-end">
          {' ' + cut(l, Math.max(0, columns - 1))}
        </Text>
      ))}
    </Box>
  )
}

function textBody(el: ClientElements, s: FileState, f: NavFile, props: NavProps): RenderElement {
  const { Box, Code } = el
  const { columns, body } = dims(props)
  const { start, lines, last } = extent(f)
  if (lines.length === 0) return message(el, ['Empty file.'], columns, body)
  const { gw, digits } = gutter(Math.max(f.lineCount, last), columns)
  const codeW = Math.max(1, columns - gw)
  const first = s.top - start
  const win = lines.slice(first, first + body)
  const cap = Math.max(codeW + 1, Math.min(400, Math.floor(9900 / Math.max(1, win.length)) - 1))
  // An empty line is drawn as one space so the Code element keeps exactly one row per line.
  const source = win.map(l => slice(clean(l), cap) || ' ').join('\n')

  return (
    <Box flexDirection="row" height={body} width={columns} flexShrink={0} overflow="hidden">
      {gw > 0 ? (
        <Box flexDirection="column" width={gw} flexShrink={0}>
          {win.map((_, i) => cell(el, s.top + i, digits, s.top + i === s.line))}
        </Box>
      ) : null}
      <Box width={codeW} flexShrink={0} overflow="hidden">
        <Code source={source} path={f.path} wrap="truncate-end" />
      </Box>
    </Box>
  )
}

function renderedBody(el: ClientElements, s: FileState, f: NavFile, props: NavProps): RenderElement {
  const { Box, Markdown } = el
  const { columns, body } = dims(props)
  if (extent(f).lines.length === 0) return message(el, ['Empty file.'], columns, body)

  return (
    // minHeight keeps the status line at the pane's foot when the markdown is short; a fixed height
    // with overflow hidden would overprint in the terminal, so the source itself is cut to fit.
    <Box flexDirection="column" width={columns} minHeight={body} flexShrink={0} paddingLeft={1}>
      <Markdown text={markdownSource(f, s.top, body, Math.max(1, columns - 1))} />
    </Box>
  )
}

function diffBody(el: ClientElements, s: FileState, f: NavFile, props: NavProps): RenderElement {
  const { Box } = el
  const { columns, body } = dims(props)
  if (!f.diff) return message(el, ['Loading diff…'], columns, body)
  const hunks = parseHunks(f.diff.hunks)
  if (hunks.length === 0) {
    const raw = clean(f.diff.hunks)
      .split('\n')
      .filter(l => l.trim() !== '')

    return message(el, raw.length === 0 ? ['No changes against HEAD.'] : raw, columns, body)
  }

  return (
    <Box flexDirection="column" height={body} width={columns} flexShrink={0} overflow="hidden">
      {diffRows(el, diffSource(hunks, s.hunk, s.diffTop ?? 0), columns, body)}
    </Box>
  )
}

/** `text` cut to `max` terminal cells (a wide character counts two), tabs as two spaces. */
function cutCells(text: string, max: number): { text: string; cells: number } {
  let out = ''
  let cells = 0
  for (const ch of text.replace(/\t/g, '  ')) {
    const w = displayCol(ch, ch.length)
    if (cells + w > max) break
    out += ch
    cells += w
  }

  return { text: out, cells }
}

/**
 * The diff drawn row by row: a gutter number (the old line for a removed line, else the new one),
 * the line's marker and text coloured, every row padded to the full width. The engine's Code
 * element in diff format leaves cells a shorter row no longer covers as they were, so a diff
 * drawn through it kept stray tails of the rows (or the file view) it replaced.
 */
function diffRows(el: ClientElements, source: string, columns: number, body: number): RenderElement[] {
  const { Text } = el
  const lines = source.split('\n')
  let top = 0
  for (const l of lines) {
    const h = HEADER.exec(l)
    if (h) top = Math.max(top, Number(h[1]), Number(h[2]))
  }
  const digits = Math.max(2, String(top + lines.length).length)
  const gw = columns >= digits + 10 ? digits + 2 : 0
  const out: RenderElement[] = []
  let oldN = 0
  let newN = 0
  for (const line of lines) {
    if (out.length >= body) break
    const m = HEADER.exec(line)
    if (m) {
      oldN = Number(m[1])
      newN = Number(m[2])
      const head = cutCells(line, columns - 1)
      out.push(
        <Text key={`d${out.length}`} wrap="truncate-end">
          <Text color="cyan" dimColor>{' ' + head.text + ' '.repeat(Math.max(0, columns - 1 - head.cells))}</Text>
        </Text>,
      )
      continue
    }
    const mark = line.charAt(0)
    if (mark === '\\') continue
    const color = mark === '+' ? 'green' : mark === '-' ? 'red' : undefined
    let num: number
    if (mark === '-') num = oldN++
    else if (mark === '+') num = newN++
    else {
      oldN++
      num = newN++
    }
    const shown = mark === '+' || mark === '-' || mark === ' ' ? line.slice(1) : line
    const text = cutCells(shown, Math.max(0, columns - gw - 2))
    const gutterText = gw > 0 ? ' ' + String(num).padStart(digits) + ' ' : ' '
    const pad = ' '.repeat(Math.max(0, columns - gutterText.length - 1 - text.cells))
    out.push(
      <Text key={`d${out.length}`} wrap="truncate-end">
        <Text dimColor>{gutterText}</Text>
        <Text color={color}>{(color ? mark : ' ') + text.text + pad}</Text>
      </Text>,
    )
  }

  return out
}

function editGeom(props: NavProps, b: Buffer): { columns: number; gw: number; digits: number; vr: number; vc: number } {
  const { columns, body } = dims(props)
  const { gw, digits } = gutter(b.lines.length, columns)

  return { columns, gw, digits, vr: Math.max(1, body), vc: Math.max(1, columns - gw) }
}

/** The cursor row split around its cell: before, the character under it (a space at the end of the line), after. */
function splitAt(text: string, col: number): { before: string; ch: string; after: string } {
  let i = 0
  while (i < text.length && displayCol(text, i) < col) {
    const c = text.charCodeAt(i)
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1
  }
  if (i >= text.length) return { before: text, ch: ' ', after: '' }
  const c = text.charCodeAt(i)
  const n = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1

  return { before: text.slice(0, i), ch: text.slice(i, i + n), after: text.slice(i + n) }
}

function editBody(el: ClientElements, s: FileState, props: NavProps): RenderElement {
  const { Box, Text } = el
  const b0 = s.buffer!
  const { columns, gw, digits, vr, vc } = editGeom(props, b0)
  const b = scrollIntoView(b0, vr, vc)
  const rows = view(b, vr, vc)
  const { body } = dims(props)

  return (
    <Box flexDirection="column" height={body} width={columns} flexShrink={0} overflow="hidden">
      {rows.map(r => {
        const isCursor = r.cursorCol !== undefined
        const g =
          gw > 0 ? (
            <Text dimColor={!isCursor} bold={isCursor}>
              {' ' + String(r.lineNo).padStart(digits) + ' '}
            </Text>
          ) : null
        if (r.cursorCol === undefined) {
          return (
            <Text wrap="truncate-end">
              {g}
              {r.text === '' ? ' ' : r.text}
            </Text>
          )
        }
        const { before, ch, after } = splitAt(r.text, Math.max(0, r.cursorCol))

        return (
          <Text wrap="truncate-end">
            {g}
            {before}
            <Text inverse>{ch}</Text>
            {after}
          </Text>
        )
      })}
    </Box>
  )
}

export function fileRender(el: ClientElements, state: FileState, props: NavProps): RenderElement {
  const { Box } = el
  const s = settle(state, props)
  const f = props.file
  const { columns, rows, body } = dims(props)
  let content: RenderElement
  let status: RenderElement
  if (s.buffer) {
    content = editBody(el, s, props)
    status = editStatus(el, s, props, columns - 1)
  } else {
    status = viewStatus(el, s, props, columns - 1)
    if (!f) {
      content = message(el, ['Nothing open.'], columns, body)
    } else if (hasDiffView(f)) {
      content = diffBody(el, s, f, props)
    } else if (f.kind === 'image') {
      content = message(el, [`PNG image (${formatSize(f.size)}): preview isn't available in the pane.`], columns, body)
    } else if (f.kind === 'binary') {
      content = message(el, [`Binary file, not shown (${formatSize(f.size)}).`], columns, body)
    } else if (f.kind === 'too-large') {
      content = message(el, [`Too large to show (${formatSize(f.size)}; the limit is 4.0 MB).`], columns, body)
    } else if (f.kind === 'missing') {
      content = message(el, ['File not found: it is not on disk.'], columns, body)
    } else if (f.text === undefined) {
      content = message(el, ['Loading…'], columns, body)
    } else if (isRendered(f)) {
      content = renderedBody(el, s, f, props)
    } else {
      content = textBody(el, s, f, props)
    }
  }

  return (
    <Box flexDirection="column" width={columns} height={rows} flexShrink={0} overflow="hidden">
      {rows > 1 ? content : null}
      {status}
    </Box>
  )
}

// --------------------------------------------------------------------------- keys

const NO_MODS = (k: ClientKeyEvent): boolean => !k.ctrl && !k.meta

/** Moves the cursor line, scrolling only as far as needed. */
function setLine(s: FileState, props: NavProps, f: NavFile, line: number): FileState {
  const { body } = dims(props)
  const { start, last } = extent(f)
  const end = Math.max(start, last)
  const h = Math.max(1, body)
  const l = clamp(line, start, end)
  let top = s.top
  if (l < top) top = l
  else if (l >= top + h) top = l - h + 1

  return { ...s, line: l, top: clamp(top, start, Math.max(start, end - h + 1)) }
}

/** Moves a screen's worth: the cursor and the window together. */
function setPage(s: FileState, props: NavProps, f: NavFile, delta: number): FileState {
  const { body } = dims(props)
  const { start, last } = extent(f)
  const end = Math.max(start, last)
  const h = Math.max(1, body)
  const top = clamp(s.top + delta, start, Math.max(start, end - h + 1))
  const line = clamp(s.line + delta, start, end)

  return { ...s, top, line: clamp(line, top, Math.min(end, top + h - 1)) }
}

function enterEdit(s: FileState, props: NavProps, f: NavFile, post: (op: NavOp) => void): FileState {
  if (!f.isEditable || f.text === undefined || f.pageCount > 1) return s
  const { start } = extent(f)
  const row = Math.max(0, (isRendered(f) ? s.top : s.line) - start)
  const b0 = fromText(f.text, row)
  const geo = editGeom(props, b0)
  const b = scrollIntoView({ ...b0, top: clamp(s.top - start, 0, b0.cursor.row) }, geo.vr, geo.vc)
  post({ op: 'edit', path: f.path, isEditing: true })

  return { ...s, buffer: b, mtimeMs: f.mtimeMs, isConflict: false, isDiscarding: false, saved: undefined, noticeAt: props.notice?.at ?? s.noticeAt ?? 0 }
}

function leaveEdit(s: FileState, props: NavProps, post: (op: NavOp) => void): FileState {
  const b = s.buffer!
  const f = props.file
  const start = f ? extent(f).start : 1
  post({ op: 'edit', path: s.path, isEditing: false })
  const next: FileState = { ...s, buffer: undefined, isConflict: false, isDiscarding: false, saved: undefined, line: start + b.cursor.row, top: start + b.top }

  return clampView(next, props)
}

function editKey(s: FileState, k: ClientKeyEvent, props: NavProps, post: (op: NavOp) => void): FileState {
  const b = s.buffer!
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key
  if (k.ctrl && !k.meta && key === 's') {
    // Nothing to save: stay quiet (a conflict still lets ctrl+s force the buffer over the disk).
    if (!b.isDirty && !s.isConflict) return s.isDiscarding ? { ...s, isDiscarding: false } : s
    const text = toText(b)
    post({ op: 'save', path: s.path, text, baseMtimeMs: s.mtimeMs, force: s.isConflict })

    return { ...s, saved: text, isDiscarding: false, noticeAt: props.notice?.at ?? s.noticeAt }
  }
  if (k.ctrl && !k.meta && key === 'q') {
    if (b.isDirty && !s.isDiscarding) return { ...s, isDiscarding: true }

    return leaveEdit(s, props, post)
  }
  const { vr } = editGeom(props, b)
  let nb = applyKey(b, k, vr)
  const geo = editGeom(props, nb)
  nb = scrollIntoView(nb, geo.vr, geo.vc)
  if (nb === b) return s.isDiscarding ? { ...s, isDiscarding: false } : s

  return { ...s, buffer: nb, isDiscarding: false, noticeAt: nb.lines !== b.lines ? (props.notice?.at ?? s.noticeAt) : s.noticeAt }
}

/** Keys that are not text: everything else without ctrl/meta is typing and belongs to Claude Code's prompt. */
const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown',
  'escape', 'esc', 'insert', 'backtab', 'clear',
])

function isPrintable(k: ClientKeyEvent): boolean {
  return !k.ctrl && !k.meta && k.key.length > 0 && !SPECIAL.has(k.key) && !/^f\d{1,2}$/.test(k.key) && k.key.charCodeAt(0) !== 0x1b
}

function diffKey(s: FileState, k: ClientKeyEvent, props: NavProps, f: NavFile, post: (op: NavOp) => void): FileState {
  const { body } = dims(props)
  const hunks = parseHunks(f.diff?.hunks ?? '')
  const lastHunk = Math.max(0, hunks.length - 1)
  const key = k.key
  const goto = (hunk: number): FileState => ({ ...s, hunk: clamp(hunk, 0, lastHunk), diffTop: 0 })
  if (!NO_MODS(k)) return s
  if (key === 'left') {
    post({ op: 'diff' })

    return { ...s, hunk: 0, diffTop: 0 }
  }
  if (key === 'up') return goto(s.hunk - 1)
  if (key === 'down') return goto(s.hunk + 1)
  if (key === 'home') return goto(0)
  if (key === 'end') return goto(lastHunk)
  const step = Math.max(1, body - 2)
  const size = Math.max(0, (hunks[s.hunk]?.length ?? 1) - 1)
  const top = s.diffTop ?? 0
  if (key === 'pagedown') {
    // The rest of this hunk is longer than the window: scroll within it; otherwise on to the next hunk.
    return size - top > body ? { ...s, diffTop: top + step } : goto(s.hunk + 1)
  }
  if (key === 'pageup') return top > 0 ? { ...s, diffTop: Math.max(0, top - step) } : goto(s.hunk - 1)

  return s
}

function viewKey(s: FileState, k: ClientKeyEvent, props: NavProps, f: NavFile, post: (op: NavOp) => void): FileState {
  // No letter commands in view mode: typing goes to Claude Code's prompt.
  if (isPrintable(k)) {
    post({ op: 'type', text: k.key })

    return s
  }
  if (hasDiffView(f)) return diffKey(s, k, props, f, post)
  const key = k.key
  const { body } = dims(props)
  const h = Math.max(1, body)
  if (!NO_MODS(k)) return s
  if (key === 'left') {
    post({ op: 'back' })

    return s
  }
  if (!isTextual(f)) return s
  if (key === 'right' || key === 'return' || key === 'enter') return enterEdit(s, props, f, post)

  const { start, last } = extent(f)
  const end = Math.max(start, last)
  const rendered = isRendered(f)
  const atEnd = (rendered ? s.top : s.line) >= end
  const atStart = (rendered ? s.top : s.line) <= start
  // Past the end of a page (or before its start) the next page is asked for; `sync` puts the cursor at its edge.
  const nextPage = (): FileState => {
    if (f.pageCount > 1 && f.page < f.pageCount - 1) post({ op: 'page', page: f.page + 1 })

    return s
  }
  const prevPage = (): FileState => {
    if (f.pageCount > 1 && f.page > 0) post({ op: 'page', page: f.page - 1 })

    return s
  }

  if (rendered) {
    // Rendered markdown scrolls by source lines (blank lines skipped, so each press moves something).
    const lines = extent(f).lines
    const at = (n: number): string => lines[n - start] ?? ''
    const scroll = (top: number): FileState => ({ ...s, top: clamp(top, start, end), line: clamp(top, start, end) })
    if (key === 'down') {
      if (atEnd) return s
      let t = s.top + 1
      while (t < end && at(t).trim() === '') t++

      return scroll(t)
    }
    if (key === 'up') {
      if (atStart) return s
      let t = s.top - 1
      while (t > start && at(t).trim() === '') t--

      return scroll(t)
    }
    if (key === 'pagedown') return atEnd ? nextPage() : scroll(s.top + Math.max(1, h - 2))
    if (key === 'pageup') return atStart ? prevPage() : scroll(s.top - Math.max(1, h - 2))
    if (key === 'home') return scroll(start)
    if (key === 'end') return scroll(end - h + 1)

    return s
  }

  if (key === 'down') return setLine(s, props, f, s.line + 1)
  if (key === 'up') return setLine(s, props, f, s.line - 1)
  if (key === 'pagedown') return atEnd ? nextPage() : setPage(s, props, f, h)
  if (key === 'pageup') return atStart ? prevPage() : setPage(s, props, f, -h)
  if (key === 'home') return setLine(s, props, f, start)
  if (key === 'end') return setLine(s, props, f, end)

  return s
}

export function fileKey(state: FileState, k: ClientKeyEvent, props: NavProps, post: (op: NavOp) => void): FileState {
  const s = settle(state, props)
  if (s.buffer) return editKey(s, k, props, post)
  const f = props.file
  if (!f) return s

  return viewKey(s, k, props, f, post)
}

// --------------------------------------------------------------------------- pointer

/** The UTF-16 index in `text` whose display column is the largest one at most `target`. */
function colAt(text: string, target: number): number {
  let i = 0
  while (i < text.length) {
    const c = text.charCodeAt(i)
    const n = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1
    if (displayCol(text, i + n) > target) return i
    i += n
  }

  return text.length
}

export function filePointer(state: FileState, p: ClientPointerEvent, props: NavProps, post: (op: NavOp) => void): FileState {
  const s = settle(state, props)
  if (p.type !== 'down' || p.button === 'right' || p.button === 'middle') return s
  const f = props.file
  const { body } = dims(props)
  if (p.y === body) {
    // The status line: its first item is the way back.
    if (s.buffer || !f || p.x >= 6) return s
    if (hasDiffView(f)) {
      post({ op: 'diff' })

      return { ...s, hunk: 0, diffTop: 0 }
    }
    post({ op: 'back' })

    return s
  }
  if (p.y < 0 || p.y >= body) return s
  if (s.buffer) {
    const b = s.buffer
    const { gw, vr, vc } = editGeom(props, b)
    const row = clamp(b.top + Math.floor(p.y), 0, b.lines.length - 1)
    const text = b.lines[row] ?? ''
    const col = colAt(text, Math.max(0, Math.floor(p.x) - gw) + b.left)
    const nb = scrollIntoView({ ...b, cursor: { row, col }, goalCol: displayCol(text, col), run: undefined }, vr, vc)

    return { ...s, buffer: nb, isDiscarding: false }
  }
  if (!f || !isTextual(f) || hasDiffView(f) || isRendered(f)) return s
  const { start, last } = extent(f)
  const line = s.top + Math.floor(p.y)
  if (line < start || line > last) return s

  return { ...s, line }
}
