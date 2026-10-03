import { describe, expect, test } from 'claude-code/testing'

import { fixture, ROOT, run } from './fixture'

const SURFACES = ['terminal', 'desktop'] as const
const SLOW = { timeoutMs: 30000 }

const pane = (surface: 'terminal' | 'desktop', columns = 60) => ({
  plugin: 'canopy',
  surface,
  component: 'Pane' as const,
  requestId: 'canopy',
  props: {
    title: 'repo',
    isFocused: true,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
})

describe('canopy pane', () => {
  test('lists the repo, opens a folder and a file, and goes back', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ key: 'row:hooks' })).toBeDefined()
      expect(await ui.find({ key: 'row:SPEC.md' })).toBeDefined()

      await ui.press({ key: 'row:hooks' })
      expect(await ui.find({ key: 'row:hooks/register.tsx' })).toBeDefined()

      await ui.press({ key: 'row:hooks/register.tsx' })
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.path).toBe('hooks/register.tsx')
      expect(code?.props.startLine).toBe(1)

      await ui.press({ key: 'back' })
      expect(await ui.find({ key: 'row:hooks/register.tsx' })).toBeDefined()
      await ui.press({ key: 'tb:collapse' })
      expect(await ui.find({ key: 'row:hooks/register.tsx' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('long files page', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('repo', 'hooks/register.tsx'))
    const ui = await $.ui.mount(pane('terminal'))
    // Pages end at 9000 characters or 400 lines, whichever comes first.
    await ui.press({ key: 'next' })
    const second = Number((await ui.find({ type: 'Code' }))?.props.startLine)
    expect(second).toBeGreaterThan(300)
    expect(second).toBeLessThanOrEqual(401)
    await ui.press({ key: 'prev' })
    expect((await ui.find({ type: 'Code' }))?.props.startLine).toBe(1)
    await ui.unmount()
  })

  test('markdown renders, and toggles to source', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('repo', 'SPEC.md'))
    const ui = await $.ui.mount(pane('terminal', 70))
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.press({ key: 'raw' })
    expect((await ui.find({ type: 'Code' }))?.props.language).toBe('markdown')
    await ui.unmount()
  })

  test('a changed file shows its diff', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files', 'hooks/repo.ts'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'diff' })
    const diff = await ui.find({ type: 'Code' })
    expect(diff?.props.format).toBe('diff')
    expect(String(diff?.props.source)).toContain('+export const repo = 1')
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

  test('the finder ranks fuzzy matches and Enter opens the first', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.input({ key: 'filter', text: 'regtsx', kind: 'change' })
    expect(await ui.find({ key: 'row:hooks/register.tsx' })).toBeDefined()
    expect(await ui.find({ key: 'row:README.md' })).toBeUndefined()
    await ui.input({ key: 'filter', text: 'regtsx' })
    expect((await ui.find({ type: 'Code' }))?.props.path).toBe('hooks/register.tsx')
    await ui.unmount()
  })

  test('git marks show in the tree', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files', 'hooks'))
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ text: /^M$/ })).toBeDefined()
    await ui.unmount()
  })

  test('Claude asking to show a file opens it at that line', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const shown = await $.tool.call({ tool: 'mcp__canopy__show_file', path: 'hooks/register.tsx', line: 850 } as never)
    expect(String(shown.result)).toContain('Showing hooks/register.tsx')
    const ui = await $.ui.mount(pane('terminal'))
    const start = Number((await ui.find({ type: 'Code' }))?.props.startLine)
    expect(start).toBeGreaterThan(600)
    expect(start).toBeLessThanOrEqual(850)
    await ui.unmount()
  })

  test("Claude's edits are marked and followed", SLOW, async ($, on) => {
    fixture(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: `${ROOT}/README.md` } as never }))
    await $.command.run(run('files'))
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'small', new_string: 'tiny' })
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Markdown' }))).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ text: /edited by Claude/ })).toBeDefined()
    await ui.unmount()
  })

  test('/files toggles the pane closed', SLOW, async ($, on) => {
    const { open } = fixture(on)
    await $.command.run(run('files'))
    expect(open.has('canopy')).toBe(true)
    await $.command.run(run('files'))
    expect(open.has('canopy')).toBe(false)
  })

  test('a narrow pane still draws', SLOW, async ($, on) => {
    fixture(on)
    await $.command.run(run('files'))
    const ui = await $.ui.mount(pane('terminal', 32))
    expect(await ui.find({ key: 'row:hooks' })).toBeDefined()
    await ui.unmount()
  })
})
