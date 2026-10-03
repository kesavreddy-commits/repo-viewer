// An in-memory repo at /repo for the tests: the kit has no file system,
// processes or pane host, so the test answers those events beneath the plugin.
import type { On } from 'claude-code'

export const ROOT = '/repo'

export const FILES: Record<string, string> = {
  'README.md': '# Fixture\n\nA small repo.\n',
  'SPEC.md': '# Spec\n\nA hard\nwrapped line.\n\n- one\n  more\n- two\n\n```ts\nconst x = 1\nconst y = 2\n```\n',
  'hooks/register.tsx': Array.from({ length: 900 }, (_, i) => `export const line${i} = ${i}`).join('\n') + '\n',
  'hooks/repo.ts': 'export const repo = 1\n',
  'assets/logo.png': '\u0089PNG',
  'new.txt': 'untracked\n',
}

const STATUS = ' M hooks/repo.ts\0?? new.txt\0'
const DIFF = 'diff --git a/hooks/repo.ts b/hooks/repo.ts\n--- a/hooks/repo.ts\n+++ b/hooks/repo.ts\n@@ -1 +1 @@\n-export const repo = 0\n+export const repo = 1\n'

// Each answer beneath the plugin is `{ value }`, a failure `{ deny }` (the caller's promise rejects).
const value = <T,>(it: T) => ({ value: it })
const ok = (stdout: string) => value({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = () => value({ exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false })

const relOf = (path: string) => (path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path)

/** What the plugin did beneath it, for the tests to check. */
export type Seen = { open: Set<string>; closes: number; filled: string[]; written: Record<string, string>; stored: Record<string, unknown> }

export function fixture(on: On, files: Record<string, string> = { ...FILES }) {
  const open = new Set<string>()
  const seen: Seen = { open, closes: 0, filled: [], written: {}, stored: {} }
  const mtimes: Record<string, number> = {}
  const isDir = (rel: string) => rel === ROOT || Object.keys(files).some(file => file.startsWith(`${rel}/`))

  on('session.cwd', () => value(ROOT))
  on('clock.now', () => value(1_000))
  on('clock.sleep', () => value(undefined))
  on('ui.panes', () => value([...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true }))))
  on('ui.open', (_$, e) => {
    open.add(e.id)
    return value({ isPlaced: true as const })
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    seen.closes += 1
    return value(undefined)
  })
  on('ui.scroll', () => ({}))
  on('ui.toast', () => value(undefined))
  on('store.get', (_$, e) => value(seen.stored[e.key]))
  on('store.set', (_$, e) => {
    seen.stored[e.key] = e.value
    return value(undefined)
  })

  on('process.run', (_$, e) => {
    const args = e.argv.filter(arg => arg !== '--no-optional-locks').slice(1).join(' ')
    if (args === 'rev-parse --show-toplevel') return ok(`${ROOT}\n`)
    if (args.startsWith('ls-files')) return ok(Object.keys(files).join('\0') + '\0')
    if (args === 'symbolic-ref --short -q HEAD') return ok('main\n')
    if (args === 'rev-parse --short HEAD') return ok('abc1234\n')
    if (args.startsWith('status')) return ok(STATUS)
    if (args.startsWith('diff')) return ok(args.endsWith('hooks/repo.ts') ? DIFF : '')
    return fail()
  })

  on('fs.stat', (_$, e) => {
    const rel = relOf(e.path)
    const text = files[rel]
    if (text !== undefined) return value({ kind: 'file' as const, size: text.length, mtimeMs: mtimes[rel] ?? 1, isLink: false })
    if (isDir(rel)) return value({ kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', (_$, e) => value(files[relOf(e.path)] !== undefined || isDir(relOf(e.path))))
  on('fs.read', (_$, e) => {
    const text = files[relOf(e.path)]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : value(text)
  })
  on('fs.write', (_$, e) => {
    const rel = relOf(e.path)
    files[rel] = e.text
    seen.written[rel] = e.text
    mtimes[rel] = (mtimes[rel] ?? 1) + 1
    return value(undefined)
  })
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  return {
    ...seen,
    seen,
    /** Someone else changes a file on disk. */
    touch(rel: string, text: string) {
      files[rel] = text
      mtimes[rel] = (mtimes[rel] ?? 1) + 100
    },
  }
}

export const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 200 },
})
