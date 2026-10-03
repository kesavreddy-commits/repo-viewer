// An in-memory repo at /repo for the tests: the kit has no file system,
// processes or pane host, so the test answers those events beneath the plugin.
import type { On } from 'claude-code'

export const ROOT = '/repo'

export const FILES: Record<string, string> = {
  'README.md': '# Fixture\n\nA small repo.\n',
  'SPEC.md': '# Spec\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n',
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
const isDir = (rel: string) => rel === ROOT || Object.keys(FILES).some(file => file.startsWith(`${rel}/`))

export function fixture(on: On) {
  const open = new Set<string>()

  on('session.cwd', () => value(ROOT))
  on('clock.now', () => value(1_000))
  on('ui.panes', () => value([...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true }))))
  on('ui.open', (_$, e) => {
    open.add(e.id)
    return value({ isPlaced: true as const })
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    return value(undefined)
  })
  on('ui.scroll', () => ({}))
  on('ui.toast', () => value(undefined))

  on('process.run', (_$, e) => {
    const args = e.argv.filter(arg => arg !== '--no-optional-locks').slice(1).join(' ')
    if (args === 'rev-parse --show-toplevel') return ok(`${ROOT}\n`)
    if (args.startsWith('ls-files')) return ok(Object.keys(FILES).join('\0') + '\0')
    if (args === 'symbolic-ref --short -q HEAD') return ok('main\n')
    if (args === 'rev-parse --short HEAD') return ok('abc1234\n')
    if (args.startsWith('status')) return ok(STATUS)
    if (args.startsWith('diff')) return ok(args.endsWith('hooks/repo.ts') ? DIFF : '')
    return fail()
  })

  on('fs.stat', (_$, e) => {
    const rel = relOf(e.path)
    const text = FILES[rel]
    if (text !== undefined) return value({ kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false })
    if (isDir(rel)) return value({ kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', (_$, e) => value(FILES[relOf(e.path)] !== undefined || isDir(relOf(e.path))))
  on('fs.read', (_$, e) => {
    const text = FILES[relOf(e.path)]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : value(text)
  })
  return { open }
}

export const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 200 },
})
