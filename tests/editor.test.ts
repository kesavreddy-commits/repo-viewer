import { describe, expect, test } from 'claude-code/testing'

import { applyKey, displayCol, fromText, scrollIntoView, toText, TAB_WIDTH, view } from '../hooks/editor'
import type { Buffer, EditKey } from '../hooks/editor'

const ROWS = 10

/** Apply a sequence of keys. Strings of length 1 or more are typed as-is; objects are key events. */
function keys(b: Buffer, ...ks: (string | EditKey)[]): Buffer {
  let cur = b
  for (const k of ks) cur = applyKey(cur, typeof k === 'string' ? { key: k } : k, ROWS)
  return cur
}
const typed = (b: Buffer, s: string): Buffer => keys(b, ...[...s])
const ctrl = (key: string, shift = false): EditKey => ({ key, ctrl: true, ...(shift ? { shift: true } : {}) })
const at = (b: Buffer): [number, number] => [b.cursor.row, b.cursor.col]
const goto = (b: Buffer, row: number, col: number): Buffer => ({ ...b, cursor: { row, col }, goalCol: displayCol(b.lines[row] ?? '', col) })

describe('editor: text round trip', () => {
  test('toText(fromText(x)) === x', () => {
    for (const x of ['', 'a', 'a\n', 'a\n\nb\n', '\n\n', 'x\r\ny\n']) expect(toText(fromText(x))).toBe(x)
  })
  test('fromText splits lines and clamps the cursor row', () => {
    const b = fromText('a\nb\nc', 99)
    expect(b.lines).toEqual(['a', 'b', 'c'])
    expect(at(b)).toEqual([2, 0])
    expect(at(fromText('a\nb', -3))).toEqual([0, 0])
    expect(at(fromText('', 5))).toEqual([0, 0])
    expect(b.isDirty).toBe(false)
  })
})

describe('editor: typing and undo', () => {
  test('typing inserts and moves the cursor', () => {
    const b = typed(fromText(''), 'hello')
    expect(toText(b)).toBe('hello')
    expect(at(b)).toEqual([0, 5])
    expect(b.isDirty).toBe(true)
  })

  test('word typing coalesces into one undo step; space and newline split steps', () => {
    let b = typed(fromText(''), 'hello world')
    expect(b.undo).toHaveLength(3) // 'hello', ' ', 'world'
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('hello ')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('hello')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('')
    expect(at(b)).toEqual([0, 0])
    expect(b.isDirty).toBe(false)
    b = keys(b, ctrl('z')) // nothing left: harmless
    expect(toText(b)).toBe('')
  })

  test('newline starts a new step', () => {
    let b = typed(fromText(''), 'ab')
    b = keys(b, 'return')
    b = typed(b, 'cd')
    expect(toText(b)).toBe('ab\ncd')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('ab\n')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('ab')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('')
  })

  test('a cursor jump starts a new step', () => {
    let b = typed(fromText(''), 'abc')
    b = keys(b, 'left', 'left')
    b = typed(b, 'X')
    b = typed(b, 'Y')
    expect(toText(b)).toBe('aXYbc')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('abc')
    expect(at(b)).toEqual([0, 1])
  })

  test('a deletion run is one step, separate from typing', () => {
    let b = typed(fromText(''), 'hello')
    b = keys(b, 'backspace', 'backspace', 'backspace')
    expect(toText(b)).toBe('he')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('hello')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('')
  })

  test('redo by ctrl+y and ctrl+shift+z; any edit clears redo', () => {
    let b = typed(fromText(''), 'ab')
    b = keys(b, ctrl('z'))
    expect(toText(b)).toBe('')
    expect(b.redo).toHaveLength(1)
    expect(toText(keys(b, ctrl('y')))).toBe('ab')
    expect(toText(keys(b, ctrl('z', true)))).toBe('ab')
    b = typed(b, 'q')
    expect(b.redo).toHaveLength(0)
    expect(toText(keys(b, ctrl('y')))).toBe('q')
  })

  test('isDirty returns to false when the text equals the original', () => {
    let b = fromText('one\ntwo')
    expect(b.isDirty).toBe(false)
    b = typed(goto(b, 1, 3), 'x')
    expect(b.isDirty).toBe(true)
    b = keys(b, 'backspace')
    expect(toText(b)).toBe('one\ntwo')
    expect(b.isDirty).toBe(false) // equal text, even though no undo happened
    b = typed(b, 'x')
    b = keys(b, ctrl('z'))
    expect(b.isDirty).toBe(false)
    b = keys(b, ctrl('y'))
    expect(b.isDirty).toBe(true)
  })

  test('the undo stack is capped at 200', () => {
    let b = fromText('')
    for (let i = 0; i < 300; i++) b = keys(b, '.')
    expect(b.undo).toHaveLength(200)
  })

  test('applyKey never mutates its input', () => {
    const b = typed(fromText('abc\ndef'), 'zz')
    const snap = JSON.stringify(b)
    for (const k of ['a', 'return', 'backspace', 'delete', 'left', 'right', 'up', 'down', 'tab', 'end', 'home', 'pagedown']) {
      applyKey(b, { key: k }, ROWS)
    }
    applyKey(b, ctrl('z'), ROWS)
    applyKey(b, ctrl('k'), ROWS)
    applyKey(b, { key: 'x\ny' }, ROWS)
    expect(JSON.stringify(b)).toBe(snap)
    const s = scrollIntoView(goto(b, 1, 3), 1, 1)
    expect(JSON.stringify(b)).toBe(snap)
    expect(s).toBeDefined()
  })

  test('ctrl/meta combos that are not handled do not insert text', () => {
    const b = fromText('abc')
    expect(toText(keys(b, ctrl('s'), { key: 'q', ctrl: true }, { key: 'x', meta: true }))).toBe('abc')
  })
})

describe('editor: return, backspace, delete', () => {
  test('return carries the leading whitespace', () => {
    let b = goto(fromText('  foo'), 0, 5)
    b = keys(b, 'return')
    expect(b.lines).toEqual(['  foo', '  '])
    expect(at(b)).toEqual([1, 2])
    b = goto(fromText('\t\tfoo'), 0, 5)
    b = keys(b, 'return')
    expect(b.lines).toEqual(['\t\tfoo', '\t\t'])
  })

  test('return in the middle splits the line and carries indent into the tail', () => {
    const b = keys(goto(fromText('  ab cd'), 0, 5), 'return')
    expect(b.lines).toEqual(['  ab ', '  cd'])
    expect(at(b)).toEqual([1, 2])
  })

  test('return inside the indentation only carries what is before the cursor', () => {
    const b = keys(goto(fromText('    x'), 0, 2), 'return')
    expect(b.lines).toEqual(['  ', '  ' + '  x'])
    expect(at(b)).toEqual([1, 2])
  })

  test('backspace joins lines at column 0', () => {
    const b = keys(goto(fromText('ab\ncd'), 1, 0), 'backspace')
    expect(b.lines).toEqual(['abcd'])
    expect(at(b)).toEqual([0, 2])
  })

  test('backspace at the very start does nothing', () => {
    const b0 = fromText('ab')
    const b = keys(b0, 'backspace')
    expect(toText(b)).toBe('ab')
    expect(b.isDirty).toBe(false)
  })

  test('delete at end of line joins the next line; at EOF does nothing', () => {
    let b = keys(goto(fromText('ab\ncd'), 0, 2), 'delete')
    expect(b.lines).toEqual(['abcd'])
    expect(at(b)).toEqual([0, 2])
    b = keys(goto(fromText('ab'), 0, 2), 'delete')
    expect(toText(b)).toBe('ab')
    b = keys(goto(fromText('abc'), 0, 1), 'delete')
    expect(toText(b)).toBe('ac')
  })

  test('backspace/delete at the join keep a trailing newline file intact', () => {
    const b = keys(goto(fromText('a\n'), 1, 0), 'backspace')
    expect(toText(b)).toBe('a')
  })
})

describe('editor: cursor movement', () => {
  test('left/right wrap across line ends', () => {
    let b = goto(fromText('ab\ncd'), 0, 2)
    b = keys(b, 'right')
    expect(at(b)).toEqual([1, 0])
    b = keys(b, 'left')
    expect(at(b)).toEqual([0, 2])
    b = keys(goto(fromText('ab'), 0, 0), 'left')
    expect(at(b)).toEqual([0, 0])
    b = keys(goto(fromText('ab'), 0, 2), 'right')
    expect(at(b)).toEqual([0, 2])
  })

  test('home and end', () => {
    let b = goto(fromText('hello\nworld'), 1, 2)
    b = keys(b, 'end')
    expect(at(b)).toEqual([1, 5])
    b = keys(b, 'home')
    expect(at(b)).toEqual([1, 0])
  })

  test('ctrl+home / ctrl+end jump to the document ends', () => {
    let b = goto(fromText('hello\nworld'), 0, 2)
    b = keys(b, { key: 'end', ctrl: true })
    expect(at(b)).toEqual([1, 5])
    b = keys(b, { key: 'home', ctrl: true })
    expect(at(b)).toEqual([0, 0])
  })

  test('up/down keep the goal column through short lines', () => {
    let b = goto(fromText('abcdefgh\nab\n\nabcdefgh'), 0, 6)
    b = keys(b, 'down')
    expect(at(b)).toEqual([1, 2])
    b = keys(b, 'down')
    expect(at(b)).toEqual([2, 0])
    b = keys(b, 'down')
    expect(at(b)).toEqual([3, 6])
    b = keys(b, 'up', 'up')
    expect(at(b)).toEqual([1, 2])
    b = keys(b, 'up')
    expect(at(b)).toEqual([0, 6])
  })

  test('a horizontal move resets the goal column', () => {
    let b = goto(fromText('abcdefgh\nab\nabcdefgh'), 0, 6)
    b = keys(b, 'down', 'left', 'down')
    expect(at(b)).toEqual([2, 1])
  })

  test('goal column is in display columns across tabs', () => {
    // row 0: 'a\tb' -> a at 0, tab 1..3, b at 4 ; cursor before b => display col 4
    let b = goto(fromText('a\tb\nabcdefgh\n\t\tx'), 0, 2)
    expect(b.goalCol).toBe(4)
    b = keys(b, 'down')
    expect(at(b)).toEqual([1, 4])
    b = keys(b, 'down') // '\t\tx': display 0..3 tab, 4..7 tab, x at 8; target 4 -> col 1 (between tabs)
    expect(at(b)).toEqual([2, 1])
    b = keys(b, 'up')
    expect(at(b)).toEqual([1, 4])
  })

  test('up on the first line goes to its start, down on the last goes to its end', () => {
    let b = keys(goto(fromText('abc\ndef'), 0, 2), 'up')
    expect(at(b)).toEqual([0, 0])
    b = keys(goto(fromText('abc\ndef'), 1, 1), 'down')
    expect(at(b)).toEqual([1, 3])
  })

  test('pageup/pagedown move by viewRows and clamp', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    let b = goto(fromText(text), 0, 3)
    b = applyKey(b, { key: 'pagedown' }, 8)
    expect(at(b)).toEqual([8, 3])
    expect(b.top).toBe(8)
    b = applyKey(b, { key: 'pagedown' }, 40)
    expect(b.cursor.row).toBe(29)
    b = applyKey(b, { key: 'pageup' }, 8)
    expect(b.cursor.row).toBe(21)
    b = applyKey(applyKey(b, { key: 'pageup' }, 100), { key: 'pageup' }, 100)
    expect(at(b)).toEqual([0, 0])
    expect(b.top).toBe(0)
  })

  test('word jumps with ctrl and meta', () => {
    const b0 = fromText('foo.bar  baz_1\n  qux')
    let b = b0
    const R: EditKey = { key: 'right', ctrl: true }
    b = keys(b, R)
    expect(at(b)).toEqual([0, 3])
    b = keys(b, R)
    expect(at(b)).toEqual([0, 4]) // '.'
    b = keys(b, R)
    expect(at(b)).toEqual([0, 7]) // bar
    b = keys(b, R)
    expect(at(b)).toEqual([0, 14]) // baz_1
    b = keys(b, R)
    expect(at(b)).toEqual([1, 0]) // wraps
    b = keys(b, R)
    expect(at(b)).toEqual([1, 5])
    const L: EditKey = { key: 'left', meta: true }
    b = keys(b, L)
    expect(at(b)).toEqual([1, 2])
    b = keys(b, L)
    expect(at(b)).toEqual([1, 0])
    b = keys(b, L)
    expect(at(b)).toEqual([0, 14])
    b = keys(b, L)
    expect(at(b)).toEqual([0, 9])
    b = keys(b, L)
    expect(at(b)).toEqual([0, 4])
    b = keys(b, L)
    expect(at(b)).toEqual([0, 3])
    b = keys(b, L)
    expect(at(b)).toEqual([0, 0])
    expect(at(keys(b, L))).toEqual([0, 0])
  })
})

describe('editor: kill, paste, unicode, tabs', () => {
  test('ctrl+k deletes to end of line, then joins', () => {
    let b = keys(goto(fromText('hello world\nnext'), 0, 5), ctrl('k'))
    expect(b.lines).toEqual(['hello', 'next'])
    b = keys(b, ctrl('k'))
    expect(b.lines).toEqual(['hellonext'])
    expect(at(b)).toEqual([0, 5])
    b = keys(b, ctrl('z'))
    expect(b.lines).toEqual(['hello', 'next'])
    b = keys(b, ctrl('z'))
    expect(b.lines).toEqual(['hello world', 'next'])
    expect(at(b)).toEqual([0, 5])
  })

  test('ctrl+u deletes to line start', () => {
    let b = keys(goto(fromText('hello world'), 0, 6), ctrl('u'))
    expect(b.lines).toEqual(['world'])
    expect(at(b)).toEqual([0, 0])
    expect(keys(b, ctrl('u'))).toBe(b) // at column 0: nothing
    b = keys(b, ctrl('z'))
    expect(b.lines).toEqual(['hello world'])
    expect(at(b)).toEqual([0, 6])
  })

  test('paste inserts text whole, with embedded newlines as line breaks', () => {
    let b = goto(fromText('ab'), 0, 1)
    b = keys(b, 'X\nY\nZ')
    expect(b.lines).toEqual(['aX', 'Y', 'Zb'])
    expect(at(b)).toEqual([2, 1])
    b = keys(b, ctrl('z'))
    expect(b.lines).toEqual(['ab'])
    expect(at(b)).toEqual([0, 1])
    b = keys(goto(fromText('ab'), 0, 2), 'one\r\ntwo\r\n')
    expect(b.lines).toEqual(['abone', 'two', ''])
    expect(at(b)).toEqual([2, 0])
    b = keys(goto(fromText(''), 0, 0), 'hello world')
    expect(b.lines).toEqual(['hello world'])
    expect(at(b)).toEqual([0, 11])
  })

  test('named non-text keys are ignored', () => {
    const b = fromText('ab')
    expect(toText(keys(b, 'escape', 'f5', ''))).toBe('ab')
  })

  test('surrogate pairs are never split', () => {
    const e = '\u{1F600}' // 2 UTF-16 units
    let b = typed(fromText(''), 'a' + e + 'b')
    expect(at(b)).toEqual([0, 4])
    b = keys(b, 'left', 'left')
    expect(at(b)).toEqual([0, 1])
    b = keys(b, 'right')
    expect(at(b)).toEqual([0, 3])
    b = keys(b, 'backspace')
    expect(toText(b)).toBe('ab')
    expect(at(b)).toEqual([0, 1])
    b = keys(typed(fromText(''), 'a' + e + 'b'), 'home', 'right', 'delete')
    expect(toText(b)).toBe('ab')
    b = keys(fromText(e), 'end')
    expect(at(b)).toEqual([0, 2])
    expect(toText(keys(b, 'backspace'))).toBe('')
    expect(toText(keys(typed(fromText(''), e + e), 'backspace'))).toBe(e)
    // a pasted emoji is one insert
    b = keys(fromText(''), e + e)
    expect(at(b)).toEqual([0, 4])
    // word jump over an emoji
    b = keys(goto(fromText('x ' + e + e + ' y'), 0, 2), { key: 'right', ctrl: true })
    expect(at(b)).toEqual([0, 6])
    b = keys(b, { key: 'left', ctrl: true })
    expect(at(b)).toEqual([0, 2])
  })

  test('displayCol: tabs, wide chars, emoji', () => {
    expect(TAB_WIDTH).toBe(4)
    expect(displayCol('\tx', 1)).toBe(4)
    expect(displayCol('a\tx', 2)).toBe(4)
    expect(displayCol('abc\tx', 4)).toBe(4)
    expect(displayCol('abcd\tx', 5)).toBe(8)
    expect(displayCol('\u4e2d\u6587x', 2)).toBe(4)
    expect(displayCol('\u{1F600}x', 2)).toBe(2)
    expect(displayCol('abc', 99)).toBe(3)
    expect(displayCol('', 0)).toBe(0)
  })

  test('tab inserts the detected indent unit', () => {
    const two = fromText('function f() {\n  if (x) {\n    y()\n  }\n}\n')
    expect(two.indent).toBe('  ')
    expect(toText(keys(goto(two, 0, 0), 'tab'))).toBe('  function f() {\n  if (x) {\n    y()\n  }\n}\n')
    const four = fromText('def f():\n    if x:\n        y()\n    z()\n')
    expect(four.indent).toBe('    ')
    expect(at(keys(goto(four, 0, 0), 'tab'))).toEqual([0, 4])
    const tabs = fromText('f {\n\ta\n\t\tb\n    c\n}\n')
    expect(tabs.indent).toBe('\t')
    expect(toText(keys(goto(tabs, 0, 0), 'tab')).split('\n')[0]).toBe('\tf {')
    expect(fromText('').indent).toBe('\t')
    expect(fromText('no indent\nat all').indent).toBe('\t')
  })

  test('shift+tab outdents the line', () => {
    let b = keys(goto(fromText('    abc'), 0, 6), { key: 'tab', shift: true })
    expect(b.lines).toEqual(['abc']) // one 4-space unit removed
    expect(at(b)).toEqual([0, 2])
    b = keys(goto(fromText('\tabc'), 0, 2), { key: 'tab', shift: true })
    expect(b.lines).toEqual(['abc'])
    expect(at(b)).toEqual([0, 1])
  })
})

describe('editor: view and scrolling', () => {
  test('view returns a window from top with 1-based line numbers; lines past the end are omitted', () => {
    let b = fromText('a\nb\nc')
    expect(view(b, 10, 20).map((r) => r.lineNo)).toEqual([1, 2, 3])
    b = { ...b, top: 1 }
    expect(view(b, 10, 20).map((r) => r.text)).toEqual(['b', 'c'])
    expect(view(b, 1, 20).map((r) => r.text)).toEqual(['b'])
    expect(view({ ...b, top: 5 }, 4, 4)).toEqual([])
  })

  test('view expands tabs and reports cursorCol on the cursor row only', () => {
    const b = goto(fromText('a\tb\nxyz'), 0, 2)
    const v = view(b, 5, 20)
    expect(v[0]).toEqual({ lineNo: 1, text: 'a   b', cursorCol: 4 })
    expect(v[1]).toEqual({ lineNo: 2, text: 'xyz' })
    expect('cursorCol' in v[1]!).toBe(false)
  })

  test('view cuts to [left, left+viewCols) in display columns; cursorCol is relative to left', () => {
    let b = goto(fromText('0123456789\n\tabcdef'), 0, 7)
    b = { ...b, left: 5 }
    expect(view(b, 5, 3)).toEqual([
      { lineNo: 1, text: '567', cursorCol: 2 },
      { lineNo: 2, text: 'bcd' },
    ])
    // the tab (display 0..3) ends before left=5, so 'a' is at display 4, 'b' at 5
    const w = view({ ...b, left: 2 }, 5, 4)
    expect(w[1]!.text).toBe('  ab')
  })

  test('wide characters are never half drawn', () => {
    const b = { ...fromText('\u4e2d\u6587abc'), left: 1 }
    expect(view(b, 1, 10)[0]!.text).toBe(' \u6587abc') // left edge cuts the first wide char
    const c = fromText('ab\u4e2d')
    expect(view(c, 1, 3)[0]!.text).toBe('ab') // right edge: second half would not fit
    expect(view(c, 1, 4)[0]!.text).toBe('ab\u4e2d')
  })

  test('scrollIntoView moves top/left minimally', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ` + 'x'.repeat(100)).join('\n')
    let b = fromText(text)
    expect(scrollIntoView(b, 10, 20)).toBe(b) // already visible: same object
    b = goto(b, 12, 0)
    b = scrollIntoView(b, 10, 20)
    expect(b.top).toBe(3)
    b = goto(b, 5, 0)
    b = scrollIntoView(b, 10, 20)
    expect(b.top).toBe(3) // 5 still inside [3, 13)
    b = goto(b, 2, 0)
    b = scrollIntoView(b, 10, 20)
    expect(b.top).toBe(2)
    b = goto(b, 2, 30)
    b = scrollIntoView(b, 10, 20)
    expect(b.left).toBe(11) // cursor cell must be inside [left, left+20)
    expect(view(b, 10, 20)[0]!.cursorCol).toBe(19)
    b = goto(b, 2, 12)
    b = scrollIntoView(b, 10, 20)
    expect(b.left).toBe(11)
    b = goto(b, 2, 3)
    b = scrollIntoView(b, 10, 20)
    expect(b.left).toBe(3)
    b = goto(b, 0, 0)
    b = scrollIntoView(b, 10, 20)
    expect(b.top).toBe(0)
    expect(b.left).toBe(0)
  })

  test('scrollIntoView counts tabs as display columns and clamps a stale top/left', () => {
    let b = goto(fromText('\t\t\t\tx'), 0, 5)
    b = scrollIntoView(b, 3, 10)
    expect(b.left).toBe(8) // cursor after x is at display col 17: left = 17 - 10 + 1
  })
})
