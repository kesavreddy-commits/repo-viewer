import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { DocPage, FileDoc, GitMark, RepoView } from '../types'

export type ViewerActions = {
  /** Return to the tree. */
  back(): void
  setPage(page: number): void
  /** Markdown rendered <-> source. */
  toggleRaw(): void
  toggleDiff(): void
  /** Show this file in the tree. */
  reveal(): void
}

export type ViewerCtx = {
  surface: RenderSurface
  columns: number
  rows: number
  doc: FileDoc
  /** For text/markdown. */
  page: DocPage | undefined
  /** Loaded only when view.showDiff. */
  diff: { hunks: string; isTruncated: boolean } | undefined
  view: RepoView
  mark?: GitMark
  isTouched: boolean
  actions: ViewerActions
}

/** Code.source and Markdown.text are refused above 10000 characters. */
const LIMIT = 10000
/** Rows the chrome (header, meta, toolbar, gap, footer, spare) takes around an image. */
const CHROME_ROWS = 6

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'c++', cpp: 'c++', hpp: 'c++', cs: 'c#',
  php: 'php', lua: 'lua', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', sql: 'sql', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', less: 'less', xml: 'xml', svg: 'svg', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', env: 'env', txt: 'text', csv: 'csv', tsv: 'tsv',
  vue: 'vue', svelte: 'svelte', graphql: 'graphql', proto: 'protobuf',
  tf: 'terraform', diff: 'diff', patch: 'diff', lock: 'lockfile', log: 'log',
}

const NAMED: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby',
}

function languageOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const named = NAMED[base]
  if (named) return named
  const dot = base.lastIndexOf('.')
  if (dot <= 0 && !(dot === 0 && base.length > 1)) return undefined

  return LANGUAGES[base.slice(dot + 1)]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `abcdefgh` to `abc…fgh` within max characters. */
function middle(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  if (max === 1) return '…'
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head

  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '')
}

/** Splits a path into a dim directory part and a bold basename that fit `avail` cells. */
function fitPath(path: string, avail: number): { dir: string; base: string } {
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash + 1)
  const base = path.slice(slash + 1)
  if (path.length <= avail) return { dir, base }
  if (base.length >= avail) return { dir: '', base: middle(base, avail) }
  const room = avail - base.length
  if (room < 2) return { dir: '', base }

  return { dir: middle(dir.slice(0, -1), room - 1) + '/', base }
}

/** Strips what Code and Markdown refuse (all control characters but tab and newline) and caps the length. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, LIMIT)
}

function countLines(text: string): number {
  if (text === '') return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  if (text.charCodeAt(text.length - 1) === 10) n--

  return n
}

function countDiff(hunks: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of hunks.split('\n')) {
    const c = line.charCodeAt(0)
    if (c === 43) add++
    else if (c === 45) del++
  }

  return { add, del }
}

function markStyle(mark: GitMark): { color: string; dimColor?: boolean; bold?: boolean } {
  switch (mark) {
    case 'M':
      return { color: 'yellow' }
    case 'A':
      return { color: 'green' }
    case '?':
      return { color: 'green', dimColor: true }
    case 'D':
      return { color: 'red' }
    case 'R':
      return { color: 'cyan' }
    case 'U':
      return { color: 'red', bold: true }
  }
}

export function Viewer(el: ElementTable, ctx: ViewerCtx): RenderElement {
  const { Box, Text, Button, Code, Markdown } = el
  const { doc, view, mark, actions } = ctx
  const columns = Math.max(20, Math.floor(ctx.columns) || 20)
  const pageCount = ctx.page?.pageCount ?? 1
  const current = Math.min(Math.max(view.page, 0), Math.max(0, pageCount - 1))
  const isText = doc.kind === 'text' || doc.kind === 'markdown'
  const isMarkdown = doc.kind === 'markdown'
  // A deleted file has no content to show, only its diff. Keep the toggle
  // reachable while the diff is showing so the person can always get out.
  const hasDiffMark = mark !== undefined && mark !== '?'
  const canDiff = (isText || doc.kind === 'missing') && (hasDiffMark || view.showDiff)
  const showingDiff = canDiff && view.showDiff
  const isPaged = isText && !showingDiff && pageCount > 1

  // 1. Header: back, path (dirs dim, basename bold), git mark, touched dot.
  const tail = (mark ? 2 : 0) + (ctx.isTouched ? 2 : 0)
  const backWidth = 9 // `b: ‹ back`
  const path = fitPath(doc.path, Math.max(8, columns - backWidth - 1 - tail))
  const header = (
    <Box flexDirection="row" gap={1}>
      <Button key="back" label="‹ back" hotkey="b" plain onPress={() => actions.back()} />
      <Box flexDirection="row">
        {path.dir ? <Text dimColor>{path.dir}</Text> : null}
        <Text bold>{path.base}</Text>
      </Box>
      {mark ? <Text {...markStyle(mark)}>{mark}</Text> : null}
      {ctx.isTouched ? <Text color="magenta">●</Text> : null}
    </Box>
  )

  // 2. Meta line.
  const parts: string[] = []
  if (isText) {
    parts.push(`${doc.lineCount} ${doc.lineCount === 1 ? 'line' : 'lines'}`)
    parts.push(formatSize(doc.size))
    const language = languageOf(doc.path)
    if (language) parts.push(language)
    if (isPaged) parts.push(`page ${current + 1}/${pageCount}`)
  } else if (doc.kind === 'image') {
    parts.push('png image', formatSize(doc.size))
  } else if (doc.kind === 'binary' || doc.kind === 'too-large') {
    parts.push(formatSize(doc.size))
  } else if (doc.kind === 'missing') {
    parts.push('not on disk')
  }
  if (showingDiff) {
    if (ctx.diff) {
      const { add, del } = countDiff(ctx.diff.hunks)
      parts.push(`diff vs HEAD +${add} −${del}`)
    } else {
      parts.push('diff vs HEAD')
    }
  }
  const meta = <Text dimColor wrap="truncate-end">{parts.join(' · ')}</Text>

  // 3. Toolbar: only the buttons that apply.
  const buttons: RenderElement[] = []
  if (isPaged && current > 0) {
    buttons.push(<Button key="prev" label="‹ prev" hotkey="p" plain onPress={() => actions.setPage(current - 1)} />)
  }
  if (isPaged && current < pageCount - 1) {
    buttons.push(<Button key="next" label="next ›" hotkey="n" plain onPress={() => actions.setPage(current + 1)} />)
  }
  if (isMarkdown && !showingDiff) {
    buttons.push(
      <Button key="raw" label={view.isRaw ? 'rendered' : 'raw'} hotkey="r" plain onPress={() => actions.toggleRaw()} />,
    )
  }
  if (canDiff) {
    buttons.push(
      <Button key="diff" label={showingDiff ? 'file' : 'diff'} hotkey="d" plain onPress={() => actions.toggleDiff()} />,
    )
  }
  buttons.push(<Button key="reveal" label="reveal" hotkey="t" plain onPress={() => actions.reveal()} />)
  const toolbar = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {buttons}
    </Box>
  )

  // 4. Body.
  let body: RenderElement
  let footer: string | undefined
  if (showingDiff) {
    if (ctx.diff && ctx.diff.hunks.trim() !== '') {
      body = <Code source={clean(ctx.diff.hunks)} format="diff" wrap="truncate-end" />
      if (ctx.diff.isTruncated) footer = '… diff truncated'
    } else {
      body = <Text dimColor>No changes against HEAD.</Text>
    }
  } else if (doc.kind === 'missing') {
    body = <Text dimColor wrap="truncate-end">{doc.error ?? 'File not found.'}</Text>
  } else if (doc.kind === 'too-large') {
    body = <Text dimColor>Too large to show ({formatSize(doc.size)}; the limit is 4.0 MB).</Text>
  } else if (doc.kind === 'binary') {
    body = <Text dimColor>Binary file, not shown.</Text>
  } else if (doc.kind === 'image') {
    if (ctx.surface === 'terminal' && 'Image' in el && doc.absPath) {
      const { Image } = el
      body = (
        <Image
          key="image"
          source={{ file: doc.absPath, format: 'png', generation: Math.floor(doc.mtimeMs) }}
          columns={Math.min(255, Math.max(1, Math.floor(columns)))}
          rows={Math.min(255, Math.max(1, Math.floor(ctx.rows) - CHROME_ROWS))}
          alt={doc.path}
        />
      )
    } else {
      body = <Text dimColor>Image preview is only available in the terminal.</Text>
    }
  } else if (!ctx.page) {
    body = <Text dimColor>Loading…</Text>
  } else if (ctx.page.text === '') {
    body = <Text dimColor>Empty file.</Text>
  } else if (isMarkdown && !view.isRaw) {
    body = <Markdown text={clean(ctx.page.text)} />
  } else {
    body = (
      <Code
        source={clean(ctx.page.text)}
        {...(isMarkdown ? { language: 'markdown', wrap: 'wrap' as const } : { path: doc.path, wrap: 'truncate-end' as const })}
        startLine={ctx.page.startLine}
      />
    )
  }

  // 5. Footer when paged.
  if (isPaged && ctx.page && !footer) {
    const first = ctx.page.startLine
    const last = first + Math.max(1, countLines(ctx.page.text)) - 1
    footer = `lines ${first}–${last} of ${doc.lineCount}`
  }

  return (
    <Box flexDirection="column">
      {header}
      {meta}
      {toolbar}
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
      {footer ? <Text dimColor wrap="truncate-end">{footer}</Text> : null}
    </Box>
  )
}
