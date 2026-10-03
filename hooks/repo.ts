// canopy data layer: parsing git output, tree rows, fuzzy find, file
// classification and paging, diffs. Pure: no JSX, no Node, no DOM, and no `$`
// (the engine follows `$` only into functions of the file that holds it, so
// register.tsx runs the commands and reads the files, and hands the output here).

import type { DocPage, FileDoc, GitMark, RepoIndex, TreeRow } from '../types'

export const MAX_FILES = 20000
export const PAGE_CHARS = 9000
export const PAGE_LINES = 400

const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_DIFF_CHARS = 9500

export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.nuxt',
  '.turbo', '.parcel-cache', 'target', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', '.cache', 'coverage',
  '.gradle', '.idea', '.DS_Store',
])

export function splitNul(out: string, isTruncated: boolean): string[] {
  const parts = out.split('\0')
  // A trailing NUL leaves an empty last field; a cut stream leaves a partial one.
  if (parts.length > 0) parts.pop()
  if (isTruncated && parts.length > 0) parts.pop()
  return parts
}

// ---------------------------------------------------------------------------
// Index

/** `git ls-files -z` output → sorted unique paths, capped at MAX_FILES. */
export function parseLsFiles(out: string, isStdoutTruncated: boolean): { files: string[]; isTruncated: boolean } {
  const uniq = Array.from(new Set(splitNul(out, isStdoutTruncated).filter((p) => p !== '')))
  uniq.sort()
  const isTruncated = isStdoutTruncated || uniq.length > MAX_FILES
  return { files: uniq.length > MAX_FILES ? uniq.slice(0, MAX_FILES) : uniq, isTruncated }
}

// ---------------------------------------------------------------------------
// Git status

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function markOf(x: string, y: string): GitMark | undefined {
  const xy = x + y
  if (xy === '??') return '?'
  if (xy === '!!') return undefined
  if (CONFLICTS.has(xy)) return 'U'
  // A removal in the work tree wins; a renamed or newly added file keeps that
  // identity even when edited further; otherwise the work tree column, then the index.
  if (y === 'D') return 'D'
  if (x === 'R' || x === 'C') return 'R'
  if (x === 'A') return 'A'
  const col = y !== ' ' ? y : x
  switch (col) {
    case 'M':
    case 'T':
      return 'M'
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
    case 'C':
      return 'R'
    default:
      return undefined
  }
}

/** `git status --porcelain=v1 -z` output → path → mark. */
export function parseGitStatus(stdout: string, isStdoutTruncated: boolean): Record<string, GitMark> {
  const out: Record<string, GitMark> = {}
  const fields = splitNul(stdout, isStdoutTruncated)
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? ''
    if (f.length < 4) continue
    const x = f[0] ?? ' '
    const y = f[1] ?? ' '
    let path = f.slice(3)
    // Renames and copies are followed by a field holding the original path.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++
    if (path.endsWith('/')) path = path.slice(0, -1)
    const m = markOf(x, y)
    if (m !== undefined && path !== '') out[path] = m
  }
  return out
}

// ---------------------------------------------------------------------------
// Paths

export function parentDirs(path: string): string[] {
  const out: string[] = []
  let i = path.indexOf('/')
  while (i !== -1) {
    out.push(path.slice(0, i))
    i = path.indexOf('/', i + 1)
  }
  return out
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function normalizeAbs(p: string): { prefix: string; rest: string } {
  const s = p.replace(/\\/g, '/')
  let prefix = '/'
  let body = s
  const drive = /^[A-Za-z]:(\/|$)/.exec(s)
  if (drive) {
    prefix = s.slice(0, 2) + '/'
    body = s.slice(2)
  }
  const out: string[] = []
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return { prefix, rest: out.join('/') }
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
}

function stripPrivate(p: string): string {
  return p.replace(/^\/private(?=\/(tmp|var|etc)\/)/, '')
}

export function toRepoPath(root: string, cwd: string, filePath: string): string | undefined {
  if (filePath === '' || root === '') return undefined
  const joined = isAbsolute(filePath) ? filePath : `${cwd === '' ? root : cwd}/${filePath}`
  const a = normalizeAbs(joined)
  const r = normalizeAbs(root)
  const isDrive = r.prefix !== '/'
  const fold = (s: string) => (isDrive ? s.toLowerCase() : s)
  if (fold(a.prefix) !== fold(r.prefix)) return undefined
  const inside = (ap: string, rp: string): string | undefined => {
    if (rp === '') return ap === '' ? undefined : ap
    if (fold(ap).startsWith(fold(rp) + '/')) return ap.slice(rp.length + 1)
    return undefined
  }
  const direct = inside(a.rest, r.rest)
  if (direct !== undefined) return direct
  // macOS: /tmp, /var and /etc are links into /private.
  if (!isDrive) {
    return inside(stripPrivate('/' + a.rest).slice(1), stripPrivate('/' + r.rest).slice(1))
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Tree

type Dir = { dirs: string[]; files: string[] }
type TreeIndex = { dirs: Map<string, Dir>; fileSet: Set<string> }

const treeCache = new WeakMap<string[], TreeIndex>()

function compareNatural(a: string, b: string): number {
  // a and b are already lower-cased keys.
  const n = a.length
  const m = b.length
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ca = a.charCodeAt(i)
    const cb = b.charCodeAt(j)
    const da = ca >= 48 && ca <= 57
    const db = cb >= 48 && cb <= 57
    if (da && db) {
      let si = i
      let sj = j
      while (si < n && a.charCodeAt(si) === 48) si++
      while (sj < m && b.charCodeAt(sj) === 48) sj++
      let ei = si
      let ej = sj
      while (ei < n && a.charCodeAt(ei) >= 48 && a.charCodeAt(ei) <= 57) ei++
      while (ej < m && b.charCodeAt(ej) >= 48 && b.charCodeAt(ej) <= 57) ej++
      const la = ei - si
      const lb = ej - sj
      if (la !== lb) return la < lb ? -1 : 1
      for (let k = 0; k < la; k++) {
        const x = a.charCodeAt(si + k)
        const y = b.charCodeAt(sj + k)
        if (x !== y) return x < y ? -1 : 1
      }
      i = ei
      j = ej
      continue
    }
    if (ca !== cb) return ca < cb ? -1 : 1
    i++
    j++
  }
  if (i < n) return 1
  if (j < m) return -1
  return 0
}

function sortPaths(paths: string[]): string[] {
  if (paths.length < 2) return paths
  const keyed = paths.map((p) => {
    const name = baseName(p)
    return { p, name, key: name.toLowerCase() }
  })
  keyed.sort((x, y) => {
    const c = compareNatural(x.key, y.key)
    if (c !== 0) return c
    return x.name < y.name ? -1 : x.name > y.name ? 1 : 0
  })
  return keyed.map((k) => k.p)
}

function buildTree(files: string[]): TreeIndex {
  const dirs = new Map<string, Dir>()
  const fileSet = new Set<string>()
  dirs.set('', { dirs: [], files: [] })
  const ensureDir = (d: string): Dir => {
    let e = dirs.get(d)
    if (e) return e
    e = { dirs: [], files: [] }
    dirs.set(d, e)
    const i = d.lastIndexOf('/')
    const parent = ensureDir(i === -1 ? '' : d.slice(0, i))
    parent.dirs.push(d)
    return e
  }
  for (const f of files) {
    fileSet.add(f)
    const i = f.lastIndexOf('/')
    ensureDir(i === -1 ? '' : f.slice(0, i)).files.push(f)
  }
  for (const d of dirs.values()) {
    d.dirs = sortPaths(d.dirs)
    d.files = sortPaths(d.files)
  }
  return { dirs, fileSet }
}

function treeOf(files: string[]): TreeIndex {
  let t = treeCache.get(files)
  if (!t) {
    t = buildTree(files)
    treeCache.set(files, t)
  }
  return t
}

export function treeRows(
  index: RepoIndex,
  expanded: ReadonlySet<string>,
  git: Record<string, GitMark>,
  touched: Record<string, number>,
): TreeRow[] {
  const base = treeOf(index.files)

  // Deleted files that git knows about but the file list does not.
  let overlay: Map<string, { dirs: Set<string>; files: string[] }> | undefined
  const changedDirs = new Set<string>()
  for (const p in git) {
    for (const d of parentDirs(p)) changedDirs.add(d)
    if (git[p] === 'D' && !base.fileSet.has(p)) {
      overlay ??= new Map()
      const add = (dir: string) => {
        let o = overlay!.get(dir)
        if (!o) {
          o = { dirs: new Set(), files: [] }
          overlay!.set(dir, o)
        }
        return o
      }
      const i = p.lastIndexOf('/')
      add(i === -1 ? '' : p.slice(0, i)).files.push(p)
      for (const d of parentDirs(p)) {
        const j = d.lastIndexOf('/')
        add(j === -1 ? '' : d.slice(0, j)).dirs.add(d)
      }
    }
  }
  const touchedDirs = new Set<string>()
  for (const p in touched) {
    if ((touched[p] ?? 0) > 0) for (const d of parentDirs(p)) touchedDirs.add(d)
  }

  const childrenOf = (dir: string): Dir => {
    const b = base.dirs.get(dir) ?? { dirs: [], files: [] }
    const o = overlay?.get(dir)
    if (!o) return b
    const dirSet = new Set(b.dirs)
    const extraDirs = [...o.dirs].filter((d) => !dirSet.has(d))
    const fileSet = new Set(b.files)
    const extraFiles = o.files.filter((f) => !fileSet.has(f))
    return {
      dirs: extraDirs.length > 0 ? sortPaths([...b.dirs, ...extraDirs]) : b.dirs,
      files: extraFiles.length > 0 ? sortPaths([...b.files, ...extraFiles]) : b.files,
    }
  }

  const rows: TreeRow[] = []
  const visit = (dir: string, depth: number) => {
    const c = childrenOf(dir)
    for (const d of c.dirs) {
      const isExpanded = expanded.has(d)
      rows.push({
        path: d,
        name: baseName(d),
        depth,
        kind: 'dir',
        isExpanded,
        hasChanges: changedDirs.has(d),
        isTouched: touchedDirs.has(d),
      })
      if (isExpanded) visit(d, depth + 1)
    }
    for (const f of c.files) {
      rows.push({
        path: f,
        name: baseName(f),
        depth,
        kind: 'file',
        isExpanded: false,
        mark: git[f],
        isTouched: (touched[f] ?? 0) > 0,
      })
    }
  }
  visit('', 0)
  return rows
}

// ---------------------------------------------------------------------------
// Fuzzy find

const lowerCache = new WeakMap<string[], string[]>()

function lowerFiles(files: string[]): string[] {
  let l = lowerCache.get(files)
  if (!l) {
    l = files.map((f) => {
      const x = f.toLowerCase()
      return x.length === f.length ? x : f
    })
    lowerCache.set(files, l)
  }
  return l
}

const NEG = -1e9
const MATCH_SCORE = 16
const CONSECUTIVE_BONUS = 6
const GAP_OPEN = 3
const BASENAME_BONUS = 2

let predBuf = new Int32Array(4096)

function boundaryBonus(orig: string, j: number): number {
  if (j === 0) return 10
  const p = orig.charCodeAt(j - 1)
  if (p === 47) return 10 // '/'
  if (p === 95 || p === 45 || p === 46 || p === 32) return 8 // _ - . space
  const c = orig.charCodeAt(j)
  if (p >= 97 && p <= 122 && c >= 65 && c <= 90) return 6 // camelCase
  return 0
}

// Best subsequence alignment of `q` in `tc` (both already case-folded as needed);
// `orig` is the original text for boundary detection. Returns the score and the
// matched indices, or undefined when `q` is not a subsequence.
function fuzzyMatch(q: string, tc: string, orig: string): { score: number; pos: number[] } | undefined {
  const m = q.length
  const n = tc.length
  if (m === 0) return { score: 0, pos: [] }
  if (m > n) return undefined
  // Cheap subsequence precheck.
  {
    let j = 0
    for (let i = 0; i < m; i++) {
      const k = tc.indexOf(q[i] as string, j)
      if (k === -1) return undefined
      j = k + 1
    }
  }
  if (predBuf.length < m * n) predBuf = new Int32Array(m * n * 2)
  const pred = predBuf
  const baseStart = orig.lastIndexOf('/') + 1
  let P = new Array<number>(n).fill(NEG)
  let C = new Array<number>(n).fill(NEG)
  for (let i = 0; i < m; i++) {
    const qc = q[i] as string
    let carry = NEG
    let carryK = -1
    for (let j = 0; j < n; j++) {
      C[j] = NEG
      if (i > 0) {
        carry -= 1
        if (j >= 2 && (P[j - 2] as number) > NEG / 2 && (P[j - 2] as number) - GAP_OPEN > carry) {
          carry = (P[j - 2] as number) - GAP_OPEN
          carryK = j - 2
        }
      }
      if (tc[j] !== qc) continue
      const bonus = boundaryBonus(orig, j) + (j >= baseStart ? BASENAME_BONUS : 0)
      if (i === 0) {
        C[j] = MATCH_SCORE + bonus
        pred[i * n + j] = -1
        continue
      }
      let best = NEG
      let bestK = -1
      if (j >= 1 && (P[j - 1] as number) > NEG / 2) {
        best = (P[j - 1] as number) + CONSECUTIVE_BONUS
        bestK = j - 1
      }
      if (carry > NEG / 2 && carry > best) {
        best = carry
        bestK = carryK
      }
      if (bestK === -1) continue
      C[j] = best + MATCH_SCORE + bonus
      pred[i * n + j] = bestK
    }
    const t = P
    P = C
    C = t
  }
  // After the last swap, P holds row m-1.
  let bestJ = -1
  let bestS = NEG / 2
  for (let j = 0; j < n; j++) {
    const s = P[j] as number
    if (s > bestS) {
      bestS = s
      bestJ = j
    }
  }
  if (bestJ === -1) return undefined
  const pos = new Array<number>(m)
  let j = bestJ
  for (let i = m - 1; i >= 0; i--) {
    pos[i] = j
    j = pred[i * n + j] as number
  }
  return { score: bestS, pos }
}

function mergeRanges(pos: number[]): Array<[number, number]> {
  pos.sort((a, b) => a - b)
  const out: Array<[number, number]> = []
  for (const p of pos) {
    const last = out[out.length - 1]
    if (last && p <= last[1]) {
      if (p + 1 > last[1]) last[1] = p + 1
    } else out.push([p, p + 1])
  }
  return out
}

/** An empty query returns the first `limit` files in order (total = every file). */
export function filterRows(
  index: RepoIndex,
  query: string,
  git: Record<string, GitMark>,
  touched: Record<string, number>,
  limit = 200,
): { rows: TreeRow[]; total: number } {
  const files = index.files
  const terms = query.split(/\s+/).filter((t) => t !== '')
  const lowers = lowerFiles(files)
  type Hit = { i: number; score: number; pos: number[] }
  const hits: Hit[] = []

  if (terms.length === 0) {
    const n = Math.min(limit, files.length)
    for (let i = 0; i < n; i++) hits.push({ i, score: 0, pos: [] })
  } else {
    const prepared = terms.map((t) => {
      const isCase = t !== t.toLowerCase()
      return { q: isCase ? t : t.toLowerCase(), isCase }
    })
    for (let i = 0; i < files.length; i++) {
      const orig = files[i] as string
      let total = 0
      const allPos: number[] = []
      let ok = true
      for (const { q, isCase } of prepared) {
        const tc = isCase ? orig : (lowers[i] as string)
        const r = fuzzyMatch(q, tc, orig)
        if (!r) {
          ok = false
          break
        }
        total += r.score
        for (const p of r.pos) allPos.push(p)
      }
      if (ok) hits.push({ i, score: total, pos: allPos })
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const fa = files[a.i] as string
      const fb = files[b.i] as string
      if (fa.length !== fb.length) return fa.length - fb.length
      return fa < fb ? -1 : fa > fb ? 1 : 0
    })
  }

  const total = terms.length === 0 ? files.length : hits.length
  const rows: TreeRow[] = []
  for (const h of hits.slice(0, Math.max(0, limit))) {
    const path = files[h.i] as string
    const row: TreeRow = {
      path,
      name: path,
      depth: 0,
      kind: 'file',
      isExpanded: false,
      mark: git[path],
      isTouched: (touched[path] ?? 0) > 0,
    }
    if (h.pos.length > 0) row.matches = mergeRanges(h.pos)
    rows.push(row)
  }
  return { rows, total }
}

// ---------------------------------------------------------------------------
// Documents

const BINARY_EXTS = new Set([
  'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'heic', 'avif', 'psd',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg', 'm4a',
  'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'class', 'pyc', 'wasm', 'bin', 'dat',
  'sqlite', 'sqlite3', 'db', 'node', 'dmg', 'iso', 'pkl', 'npy', 'parquet', 'lockb',
])
const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown'])

function extOf(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

function countLines(text: string): number {
  if (text === '') return 0
  let n = 1
  let i = text.indexOf('\n')
  while (i !== -1) {
    if (i < text.length - 1) n++
    i = text.indexOf('\n', i + 1)
  }
  return n
}

function sanitize(text: string): string {
  let t = text
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
  if (t.indexOf('\r') !== -1) t = t.replace(/\r\n/g, '\n')
  // Everything but tab and newline: C0, DEL, C1 (a lone \r included).
  return t.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
}

/** A FileDoc with nothing read yet. */
export function emptyDoc(path: string, kind: FileDoc['kind'], extra: Partial<FileDoc> = {}): FileDoc {
  return { path, kind, lineCount: 0, size: 0, mtimeMs: 0, ...extra }
}

/** What a stat alone decides about a file; undefined when its text must be read. */
export function docFromStat(
  root: string,
  path: string,
  st: { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number },
): FileDoc | undefined {
  const base = { size: st.size, mtimeMs: st.mtimeMs }
  if (st.kind === 'dir') return emptyDoc(path, 'missing', { ...base, error: 'is a directory' })
  if (st.kind !== 'file') return emptyDoc(path, 'missing', { ...base, error: 'not a regular file' })
  if (st.size > MAX_READ_BYTES) return emptyDoc(path, 'too-large', base)
  const ext = extOf(path)
  if (ext === 'png') return emptyDoc(path, 'image', { ...base, absPath: `${root}/${path}` })
  if (BINARY_EXTS.has(ext)) return emptyDoc(path, 'binary', base)
  return undefined
}

/** A file's text → its doc: binary when it holds a NUL early, else markdown or text, sanitized. */
export function docFromText(path: string, st: { size: number; mtimeMs: number }, raw: string): FileDoc {
  const base = { size: st.size, mtimeMs: st.mtimeMs }
  if (raw.slice(0, 8000).indexOf('\0') !== -1) return emptyDoc(path, 'binary', base)
  const text = sanitize(raw)
  return emptyDoc(path, MARKDOWN_EXTS.has(extOf(path)) ? 'markdown' : 'text', { ...base, text, lineCount: countLines(text) })
}

export function errText(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = String((e as { message: unknown }).message)
    if (m !== '') return m
  }
  return fallback
}

// ---------------------------------------------------------------------------
// Paging

type PageSpan = { start: number; end: number; startLine: number }
let pageCache: { text: string; spans: PageSpan[] } | undefined

function spansOf(fullText: string): PageSpan[] {
  if (pageCache && pageCache.text === fullText) return pageCache.spans
  // A final newline ends the last line rather than starting another.
  const text = fullText.endsWith('\n') ? fullText.slice(0, -1) : fullText
  const spans: PageSpan[] = []
  const len = text.length
  let pos = 0 // start of the next unconsumed line (or mid-line remainder)
  let lineNo = 1 // logical line number of the text at `pos`
  while (pos < len || spans.length === 0) {
    if (len === 0) {
      spans.push({ start: 0, end: 0, startLine: 1 })
      break
    }
    const start = pos
    const startLine = lineNo
    let end = pos
    let lines = 0
    for (;;) {
      if (end >= len) break
      if (lines >= PAGE_LINES) break
      const nl = text.indexOf('\n', end)
      const lineEnd = nl === -1 ? len : nl
      const next = nl === -1 ? len : nl + 1
      // Chars this page would span if it took the line (newline excluded at the end).
      if (lineEnd - start > PAGE_CHARS) {
        if (lines === 0) {
          // One line longer than a page: hard-cut it, never inside a surrogate pair.
          let cut = start + PAGE_CHARS
          const c = text.charCodeAt(cut - 1)
          if (c >= 0xd800 && c <= 0xdbff) cut--
          end = cut
          pos = cut
          // The rest of the line continues on the next page under the same number.
          lines = -1
        }
        break
      }
      end = next
      lines++
      lineNo++
    }
    if (lines === -1) {
      spans.push({ start, end, startLine })
      continue
    }
    pos = end
    // Drop the newline that ends the page's last line.
    const spanEnd = end > start && text.charCodeAt(end - 1) === 10 ? end - 1 : end
    spans.push({ start, end: spanEnd, startLine })
  }
  pageCache = { text: fullText, spans }
  return spans
}

export function pageOf(doc: FileDoc, page: number): DocPage {
  const fullText = doc.text ?? ''
  const spans = spansOf(fullText)
  const text = fullText.endsWith('\n') ? fullText.slice(0, -1) : fullText
  const p = Math.min(Math.max(Number.isFinite(page) ? Math.trunc(page) : 0, 0), spans.length - 1)
  const s = spans[p] as PageSpan
  return { text: text.slice(s.start, s.end), startLine: s.startLine, pageCount: spans.length }
}

// ---------------------------------------------------------------------------
// Diff

/** `git diff` output → its hunks, cut at a hunk boundary to MAX_DIFF_CHARS; undefined when none. */
export function parseDiff(stdout: string, isStdoutTruncated: boolean): { hunks: string; isTruncated: boolean } | undefined {
  if (stdout === '') return undefined
  const out = sanitize(stdout)
  const at = out.startsWith('@@') ? 0 : out.indexOf('\n@@')
  if (at === -1) return undefined
  const body = (at === 0 ? out : out.slice(at + 1)).replace(/\n$/, '')
  if (body.length <= MAX_DIFF_CHARS && !isStdoutTruncated) return { hunks: body, isTruncated: false }
  // Keep whole hunks while they fit.
  let cut = -1
  let from = 0
  for (;;) {
    const next = body.indexOf('\n@@', from + 1)
    if (next === -1 || next > MAX_DIFF_CHARS) break
    cut = next
    from = next
  }
  if (body.length <= MAX_DIFF_CHARS) return { hunks: body, isTruncated: true }
  if (cut === -1) {
    // The first hunk alone is too long: cut at a line boundary.
    const nl = body.lastIndexOf('\n', MAX_DIFF_CHARS)
    cut = nl > 0 ? nl : MAX_DIFF_CHARS
  }
  return { hunks: body.slice(0, cut), isTruncated: true }
}

// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (Math.round(v * 10) / 10 >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}
