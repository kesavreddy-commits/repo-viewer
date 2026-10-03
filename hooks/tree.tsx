// The repo tree and fuzzy finder, drawn as a pure function of the pane state.
//
// Every row is exactly one terminal line: a keyed plain Button (the label is
// the row's left side: gutter, indent, chevron, name) beside a small Text for
// the right-edge markers (touched dot, git mark). A Button's label is one
// string, so styling inside it (matched characters, struck-through deleted
// names, the cursor bar) is drawn as small absolutely placed Texts painted over
// the label's cells; the Button stays the one thing Tab, arrows, Enter and
// clicks reach.
import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'
import type { GitMark, RepoView, RepoIndex, TreeRow } from '../types'

export type TreeActions = {
  press(row: TreeRow): void // dir: toggle expand; file: open in viewer
  setFilter(query: string): void
  collapseAll(): void
  refresh(): void
  toggleFollow(): void
  openFirstMatch(): void // Enter in the finder
  close(): void // our own close button, beside the engine's ✕
}

export type TreeCtx = {
  surface: RenderSurface
  columns: number
  rows: number
  index: RepoIndex | null // null → loading
  rows_: TreeRow[] // visible rows (tree or filtered)
  total: number // filter mode: total matches
  view: RepoView
  changedCount: number // files with a git mark
  touchedCount: number
  actions: TreeActions
  /** Drawn in place of the rows and the hint: the pane's keyboard Client, where the surface has one. */
  body?: RenderElement
  /** Extra toolbar buttons (the keyboard-only h/j/k/l moves). */
  tools?: RenderElement[]
}

/** Most rows drawn; the rest collapse into a dim "… N more". */
export const MAX_ROWS = 500
/**
 * The engine bounds a drawn tree to 100,000 serialized characters (past it the
 * instance unmounts), so rows are also drawn only up to this many characters.
 */
const ROW_CHAR_BUDGET = 85_000

const ELLIPSIS = '…'

// ---------------------------------------------------------------- text helpers

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

/** Control characters in a file name would break the one-line rule. */
function glyphsOf(text: string, ranges: Array<[number, number]> | undefined): Glyph[] {
  const out: Glyph[] = []
  let at = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isControl = cp < 32 || (cp >= 127 && cp < 160)
    const hit = !!ranges && ranges.some(r => at >= r[0] && at < r[1])
    out.push({ s: isControl ? '?' : ch, w: isControl ? 1 : cellWidth(cp), hit })
    at += ch.length
  }
  return out
}

const sumWidth = (g: readonly Glyph[]): number => g.reduce((n, x) => n + x.w, 0)

/** Cut to `max` cells keeping the start (tree names). */
function cutEnd(g: Glyph[], max: number): Glyph[] {
  if (sumWidth(g) <= max) return g
  const out: Glyph[] = []
  let w = 0
  for (const x of g) {
    if (w + x.w > max - 1) break
    out.push(x)
    w += x.w
  }
  out.push({ s: ELLIPSIS, w: 1, hit: false })
  return out
}

/** Cut to `max` cells with the ellipsis in the middle, favouring the tail (the file name). */
function cutMiddle(g: Glyph[], max: number): Glyph[] {
  if (sumWidth(g) <= max) return g
  if (max <= 1) return max === 1 ? [{ s: ELLIPSIS, w: 1, hit: false }] : []
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
  return [...head, { s: ELLIPSIS, w: 1, hit: false }, ...tail]
}

/** [startCell, text] runs of consecutive matched glyphs, cell-offset by `base`. */
function hitRuns(g: readonly Glyph[], base: number): Array<[number, string]> {
  const runs: Array<[number, string]> = []
  let cell = base
  let cur: [number, string] | undefined
  for (const x of g) {
    if (x.hit) {
      if (cur) cur[1] += x.s
      else {
        cur = [cell, x.s]
        runs.push(cur)
      }
    } else {
      cur = undefined
    }
    cell += x.w
  }
  return runs
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

// ------------------------------------------------------------------- the rows

/** Width of the right-hand marker cluster (`● M`) plus one gap cell. */
const MARKER_CELLS = 3
const MARKER_GAP = 1

function Row(el: ElementTable, ctx: TreeCtx, row: TreeRow, isFilter: boolean): RenderElement {
  const { Box, Text, Button } = el
  const W = Math.max(1, ctx.columns)

  // Right side: touched dot, then the git mark (files) or a changes dot (dirs).
  const mark = row.kind === 'file' && row.mark ? markOf(row.mark) : undefined
  const hasDirDot = row.kind === 'dir' && !!row.hasChanges
  const hasMarker = !!mark || hasDirDot || row.isTouched
  const room = hasMarker ? W - MARKER_CELLS - MARKER_GAP : W

  // Left side: gutter (the cursor bar draws over it), indent, chevron, name.
  const isCursor = ctx.view.cursor !== '' && ctx.view.cursor === row.path
  let prefix = ' '
  if (!isFilter) {
    const indent = Math.min(row.depth * 2, Math.max(0, Math.floor(room / 2)))
    prefix += ' '.repeat(indent)
    prefix += row.kind === 'dir' ? (row.isExpanded ? '▾ ' : '▸ ') : '  '
  } else {
    prefix += row.kind === 'dir' ? (row.isExpanded ? '▾ ' : '▸ ') : ''
  }
  const prefixW = strWidth(prefix)
  const nameRoom = Math.max(1, room - prefixW)

  const suffix = row.kind === 'dir' && !isFilter ? '/' : ''
  const raw = glyphsOf(row.name + suffix, isFilter ? row.matches : undefined)
  const glyphs = isFilter ? cutMiddle(raw, nameRoom) : cutEnd(raw, nameRoom)
  const label = prefix + glyphs.map(x => x.s).join('')

  const overlays: RenderElement[] = []
  if (isCursor) {
    overlays.push(
      <Box position="absolute" left={0}>
        <Text color="cyan" bold>
          ▎
        </Text>
      </Box>,
    )
  }
  if (isFilter) {
    for (const [left, text] of hitRuns(glyphs, prefixW)) {
      overlays.push(
        <Box position="absolute" left={left}>
          <Text color="cyan" bold>
            {text}
          </Text>
        </Box>,
      )
    }
  } else if (mark?.ch === 'D') {
    // A deleted file's name, struck through in red.
    overlays.push(
      <Box position="absolute" left={prefixW}>
        <Text color="red" strikethrough>
          {glyphs.map(x => x.s).join('')}
        </Text>
      </Box>,
    )
  }

  let markers: RenderElement | undefined
  if (hasMarker) {
    const touched = row.isTouched ? (
      <Text color="magenta">●</Text>
    ) : (
      ' '
    )
    const right = mark ? (
      <Text color={mark.color} dimColor={mark.dim} bold={mark.bold}>
        {mark.ch}
      </Text>
    ) : hasDirDot ? (
      <Text dimColor>•</Text>
    ) : (
      ' '
    )
    markers = (
      <Text>
        {touched} {right}
      </Text>
    )
  }

  const button = (
    <Button
      key={`row:${row.path}`}
      plain
      dimColor={mark?.ch === 'D'}
      label={label}
      onPress={() => ctx.actions.press(row)}
    />
  )
  // A bare row (no markers, nothing drawn over it) is just the Button: lighter on the tree budget.
  if (!markers && overlays.length === 0) return button

  return (
    <Box flexDirection="row" justifyContent="space-between" width={W}>
      {button}
      {markers}
      {overlays}
    </Box>
  )
}

// ----------------------------------------------------------------- the pane

function repoName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

const n = (value: number): string => value.toLocaleString('en-US')

/** Cells between the divider and the pane's chrome, matching the tree rows' own gutter. */
const PAD = 1
/** Cells the engine's close mark covers at the right edge, plus a gap: the header stops short of them. */
const CLOSE_RESERVE = 2 + 5 + 1

/** The finder gets a rounded border (three rows) when the pane has this many rows to spare. */
const hasBoxedFinder = (rows: number): boolean => rows >= 16

/** Rows the hooks-drawn chrome takes above the Client: header, counts, finder (1 or 3), toolbar. */
export const treeChromeRows = (rows: number): number => (hasBoxedFinder(rows) ? 6 : 4)

export function Tree(el: ElementTable, ctx: TreeCtx): RenderElement {
  const { Box, Text, Button } = el
  const W = Math.max(1, ctx.columns)
  const { index, view, actions } = ctx
  const isFilter = view.filter.trim() !== ''

  // 1. Header: repo folder bold, branch dim, our close button at the right (the engine's own dim
  // ✕ is drawn over the last two cells of this row, so the button stops short of them and the two
  // read as one `close ✕`). Then the counts, dim. Everything sits one cell in from the divider,
  // lined up with the tree's chevrons.
  const hasClose = W >= 28
  const left = Math.max(4, W - PAD - (hasClose ? CLOSE_RESERVE : PAD))
  let header: RenderElement
  let counts: RenderElement | undefined
  if (index) {
    const name = fit(repoName(index.root), left)
    const branchRoom = left - strWidth(name) - 3
    const branch = index.isGit && index.branch && branchRoom >= 4 ? fit(index.branch, branchRoom) : ''
    header = (
      <Text wrap="truncate-end">
        <Text bold>{name}</Text>
        {branch ? <Text dimColor>{` ⎇ ${branch}`}</Text> : null}
      </Text>
    )
    const bits = [`${n(index.files.length)}${index.isTruncated ? '+' : ''} files`]
    if (ctx.changedCount > 0) bits.push(`${n(ctx.changedCount)} changed`)
    if (ctx.touchedCount > 0) bits.push(`${n(ctx.touchedCount)} edited by Claude`)
    counts = (
      <Box paddingLeft={PAD}>
        <Text dimColor wrap="truncate-end">
          {fit(bits.join(' · '), W - PAD * 2)}
        </Text>
      </Box>
    )
  } else {
    header = <Text bold>Repo</Text>
  }
  const top = (
    <Box flexDirection="row" justifyContent="space-between" paddingLeft={PAD} paddingRight={hasClose ? 2 : PAD}>
      {header}
      {hasClose ? <Button key="close" plain role="dismiss" label="close" onPress={() => actions.close()} /> : null}
    </Box>
  )

  // 2. Finder: a search field. Boxed (three rows) when the pane is tall enough to spare them.
  const isBoxed = hasBoxedFinder(ctx.rows)
  let finder: RenderElement | undefined
  if ('Input' in el) {
    const { Input } = el
    // The field sits alone in a column box that grows, so it stretches across the whole box: a click
    // anywhere in the row focuses it (a field beside a glyph in a row box took only its text's cells).
    // autoFocus: after ctrl+x tab, a click on the pane or `/files`, the ring starts on the finder.
    const field = (
      <Input
        key="filter"
        placeholder="Filter files…"
        value={view.filter}
        autoFocus
        onInput={(value: string) => actions.setFilter(value)}
        onSubmit={() => actions.openFirstMatch()}
      />
    )
    finder = isBoxed ? (
      <Box paddingX={PAD}>
        <Box key="finder" flexGrow={1} borderStyle="round" borderDimColor paddingX={1} gap={1} hover={{ borderDimColor: false }}>
          <Text dimColor>⌕</Text>
          <Box flexGrow={1} flexDirection="column">
            {field}
          </Box>
        </Box>
      </Box>
    ) : (
      <Box paddingLeft={PAD} gap={1}>
        <Text dimColor>⌕</Text>
        <Box flexGrow={1} flexDirection="column">
          {field}
        </Box>
      </Box>
    )
  }

  // 3. Toolbar: secondary actions, dim until pointed at or focused.
  const collapseLabel = W >= 44 ? 'collapse all' : 'collapse'
  const toolbar = (
    <Box flexDirection="row" columnGap={3} flexWrap="wrap" paddingLeft={PAD}>
      <Button key="tb:refresh" plain dimColor label="refresh" onPress={() => actions.refresh()} />
      <Button key="tb:collapse" plain dimColor label={collapseLabel} onPress={() => actions.collapseAll()} />
      <Button
        key="tb:follow"
        plain
        dimColor={!view.follow}
        label={`follow ${view.follow ? 'on' : 'off'}`}
        onPress={() => actions.toggleFollow()}
      />
    </Box>
  )

  // 4. Body: rows or an empty state.
  const body: RenderElement[] = []
  const shown = ctx.rows_
  let drawn = 0
  if (!index) {
    body.push(<Text dimColor>Loading files…</Text>)
  } else if (shown.length === 0) {
    if (isFilter) {
      body.push(<Text dimColor wrap="truncate-end">{fit(`No files match "${view.filter}"`, W)}</Text>)
    } else if (index.files.length === 0) {
      body.push(<Text dimColor>No files in this repo.</Text>)
    } else {
      body.push(<Text dimColor>Nothing to show.</Text>)
    }
  } else {
    if (isFilter) {
      const matches = Math.max(ctx.total, shown.length)
      const info = `${n(matches)} match${matches === 1 ? '' : 'es'}`
      body.push(<Text dimColor>{fit(info, W)}</Text>)
    }
    let budget = ROW_CHAR_BUDGET
    for (const row of shown) {
      if (drawn >= MAX_ROWS) break
      const rendered = Row(el, ctx, row, isFilter)
      budget -= JSON.stringify(rendered).length
      if (budget < 0) break
      body.push(rendered)
      drawn++
    }
    const total = isFilter ? Math.max(ctx.total, shown.length) : shown.length
    const more = total - drawn
    if (more > 0) {
      const text = isFilter ? `… ${n(more)} more · keep typing to narrow` : `… ${n(more)} more`
      body.push(<Text dimColor>{fit(text, W)}</Text>)
    }
  }

  // 5. Hint.
  const hintFull = '↑↓ move · ⏎ open · ctrl+x tab focus'
  const hint = strWidth(hintFull) <= W ? hintFull : fit('↑↓ move · ⏎ open', W)

  if (ctx.body) {
    return (
      <Box flexDirection="column">
        {top}
        {counts}
        {finder}
        {toolbar}
        {ctx.tools && ctx.tools.length > 0 ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {ctx.tools}
          </Box>
        ) : null}
        {ctx.body}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {top}
      {counts}
      {finder}
      {toolbar}
      <Box flexDirection="column">{body}</Box>
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}
