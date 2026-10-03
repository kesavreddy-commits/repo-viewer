import { describe, expect, test } from 'claude-code/testing'

import { fixture, FILES, ROOT, run } from './fixture'

const SURFACES = ['terminal', 'desktop'] as const
const SLOW = { timeoutMs: 30000 }

const pane = <S extends 'terminal' | 'desktop' | 'vscode'>(surface: S, columns = 60) => ({
  plugin: 'repo-viewer',
  surface,
  component: 'Pane' as const,
  requestId: 'repo-viewer',
  props: {
    title: 'repo',
    isFocused: true,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
})

type Found = { text: string; props: Record<string, unknown> } | undefined
type Finder = { find: (q: { in?: string; type?: string; text?: RegExp }) => Promise<Found> }

/** What the pane's keyboard Client drew, as one string. */
const drawn = async (ui: Finder) => (await ui.find({ in: 'nav', type: 'Box' }))?.text ?? ''
const codeIn = async (ui: Finder) => (await ui.find({ in: 'nav', type: 'Code' }))?.props

describe('tree and arrows', () => {
  test('arrows walk into folders and files and back out', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await drawn(ui)).toContain('hooks/')
      expect(await drawn(ui)).toContain('SPEC.md')

      // Folders sort first: assets/, hooks/. Home, then down, lands on hooks/.
      await ui.key({ key: 'home', in: 'nav' })
      await ui.key({ key: 'down', in: 'nav' })
      await ui.key({ key: 'right', in: 'nav' })
      expect(await drawn(ui)).toContain('register.tsx')

      // → again steps into the folder, → on a file opens it.
      await ui.key({ key: 'right', in: 'nav' })
      await ui.key({ key: 'right', in: 'nav' })
      expect((await codeIn(ui))?.path).toBe('hooks/register.tsx')

      // ← leaves the file, ← again goes up to the folder, ← once more collapses it.
      await ui.key({ key: 'left', in: 'nav' })
      expect(await drawn(ui)).toContain('register.tsx')
      await ui.key({ key: 'left', in: 'nav' })
      await ui.key({ key: 'left', in: 'nav' })
      expect(await drawn(ui)).not.toContain('register.tsx')
      await ui.unmount()
    }
  })

  test('← at the top level and typing hand the keys back to the prompt', SLOW, async ($, on) => {
    const fx = fixture(on)
    await $.command.run(run('files'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.key({ key: 'down', in: 'nav' })
    const before = fx.seen.closes
    await ui.key({ key: 'left', in: 'nav' })
    expect(fx.seen.closes).toBe(before + 1)
    expect(fx.open.has('repo-viewer')).toBe(true)

    await ui.key({ key: 'f', in: 'nav' })
    expect(fx.seen.filled).toEqual(['f'])
    await ui.unmount()
  })

  test('the finder ranks fuzzy matches and Enter opens the first', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.input({ key: 'filter', text: 'regtsx', kind: 'change' })
    expect(await drawn(ui)).toContain('hooks/register.tsx')
    expect(await drawn(ui)).not.toContain('README.md')
    await ui.input({ key: 'filter', text: 'regtsx' })
    expect((await codeIn(ui))?.path).toBe('hooks/register.tsx')
    await ui.unmount()
  })

  test('git marks and Claude edits show in the tree', SLOW, async ($, on) => {
    fixture(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: `${ROOT}/README.md` } as never }))
    await $.command.run(run('files', 'hooks'))
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'small', new_string: 'tiny' })
    const ui = await $.ui.mount(pane('terminal'))
    // Following the edit opened README.md; back to the tree to see the marks.
    await ui.key({ key: 'left', in: 'nav' })
    const tree = await drawn(ui)
    expect(tree).toMatch(/repo\.ts.*M/)
    expect(tree).toContain('●')
    expect(await ui.find({ text: /edited by Claude/ })).toBeDefined()
    await ui.unmount()
  })

  test('a narrow pane still draws', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const ui = await $.ui.mount(pane('terminal', 32))
    expect(await drawn(ui)).toContain('hooks/')
    await ui.unmount()
  })

  test('/files toggles the pane closed', SLOW, async ($, on) => {
    const { open } = fixture(on)
    await $.command.run(run('files'))
    expect(open.has('repo-viewer')).toBe(true)
    await $.command.run(run('files'))
    expect(open.has('repo-viewer')).toBe(false)
  })
})

describe('file view', () => {
  test('markdown renders, and the toolbar toggles it to source', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('repo', 'SPEC.md'))
    const ui = await $.ui.mount(pane('terminal', 70))
    expect(await ui.find({ in: 'nav', type: 'Markdown' })).toBeDefined()
    await ui.press({ key: 'raw' })
    expect(await ui.find({ in: 'nav', type: 'Markdown' })).toBeUndefined()
    expect(await codeIn(ui)).toBeDefined()
    await ui.unmount()
  })

  test('a changed file shows its diff', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files', 'hooks/repo.ts'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'diff' })
    const diff = await codeIn(ui)
    expect(diff?.format).toBe('diff')
    expect(String(diff?.source)).toContain('+export const repo = 1')
    await ui.unmount()
  })

  test('a png draws as an image in the terminal only', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files', 'assets/logo.png'))
    const terminal = await $.ui.mount(pane('terminal'))
    expect((await terminal.find({ type: 'Image' }))?.props.source).toMatchObject({ file: `${ROOT}/assets/logo.png`, format: 'png' })
    await terminal.unmount()
    const desktop = await $.ui.mount(pane('desktop'))
    expect(await desktop.find({ type: 'Image' })).toBeUndefined()
    await desktop.unmount()
  })

  test('Claude asking to show a file opens it at that line', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const shown = await $.tool.call({ tool: 'mcp__repo-viewer__show_file', path: 'hooks/register.tsx', line: 850 } as never)
    expect(String(shown.result)).toContain('Showing hooks/register.tsx')
    const ui = await $.ui.mount(pane('terminal'))
    expect(String((await codeIn(ui))?.source)).toContain('line849')
    await ui.unmount()
  })
})

describe('editing in the pane', () => {
  test('→ edits, typing changes the buffer, ctrl+s saves the whole file', SLOW, async ($, on) => {
    const fx = fixture(on)
    await $.command.run(run('files', 'README.md'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.key({ key: 'right', in: 'nav' })
    expect(await drawn(ui)).toContain('EDIT')
    await ui.key({ key: 'X', in: 'nav' })
    expect(fx.seen.filled).toEqual([])
    await ui.key({ key: 's', ctrl: true, in: 'nav' })
    expect(fx.seen.written['README.md']).toBe(`X${FILES['README.md']}`)
    expect(await drawn(ui)).not.toContain('modified')
    await ui.key({ key: 'q', ctrl: true, in: 'nav' })
    expect(await drawn(ui)).not.toContain('EDIT')
    await ui.unmount()
  })

  test('a save is refused when the file changed on disk, and the second ctrl+s overwrites', SLOW, async ($, on) => {
    const fx = fixture(on)
    await $.command.run(run('files', 'README.md'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.key({ key: 'right', in: 'nav' })
    await ui.key({ key: 'Y', in: 'nav' })
    fx.touch('README.md', 'someone else\n')
    await ui.key({ key: 's', ctrl: true, in: 'nav' })
    expect(fx.seen.written['README.md']).toBeUndefined()
    expect(await drawn(ui)).toContain('changed on disk')
    await ui.key({ key: 's', ctrl: true, in: 'nav' })
    expect(fx.seen.written['README.md']).toBe(`Y${FILES['README.md']}`)
    await ui.unmount()
  })
})

describe('surfaces without a Client', () => {
  test('VS Code draws the button tree', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const ui = await $.ui.mount(pane('vscode'))
    expect(await ui.find({ key: 'row:hooks' })).toBeDefined()
    await ui.press({ key: 'row:hooks' })
    await ui.press({ key: 'row:hooks/register.tsx' })
    expect((await ui.find({ type: 'Code' }))?.props.path).toBe('hooks/register.tsx')
    await ui.unmount()
  })
})
