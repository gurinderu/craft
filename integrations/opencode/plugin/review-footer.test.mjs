// The review's footer line, TUI side, against a fake `t` and a fake UI runtime shaped as observed on 2.2.7.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { apply, footerPlugin, shown, SLOT, variantOf } from './review-footer.mjs'
import { REVIEW_RPC } from './review-rpc.mjs'

// A fake runtime: an element is a record, `insert` keeps the text accessor, a signal is a plain cell.
/** @type {import('./review-footer.mjs').Solid} */
const solid = {
  createElement: (/** @type {string} */ tag) => ({ tag, props: /** @type {Record<string, unknown>} */ ({}) }),
  insert: (/** @type {any} */ el, /** @type {() => string} */ value) => {
    el.text = value
  },
  setProp: (/** @type {any} */ el, /** @type {string} */ name, /** @type {unknown} */ value) => {
    el.props[name] = value
  },
  effect: (/** @type {() => void} */ fn) => fn(),
  createSignal: value => {
    let v = value
    return [
      () => v,
      next => {
        v = next
      },
    ]
  },
}

function fakeT(route = { type: 'session', sessionID: 'a' }) {
  /** @type {any[]} */
  const slots = []
  /** @type {any[]} */
  const toasts = []
  /** @type {Record<string, (e: unknown) => void>} */
  const handlers = {}
  /** @type {unknown[]} */
  const defs = []
  let off = 0
  const t = {
    client: {
      rpc: (/** @type {unknown} */ def) => {
        defs.push(def)
        return {
          events: {
            on: (/** @type {string} */ name, /** @type {(e: unknown) => void} */ cb) => {
              handlers[name] = cb
              return () => off++
            },
          },
        }
      },
    },
    ui: {
      slot: (/** @type {any} */ s) => slots.push(s),
      toast: { show: (/** @type {unknown} */ x) => toasts.push(x) },
      router: { current: () => route },
    },
    theme: { text: { muted: 'grey' } },
  }
  return { t, slots, toasts, handlers, defs, route, off: () => off }
}

const event = (/** @type {string} */ sessionID, /** @type {string} */ line, done = false) => ({
  type: 'rpc.craft.review.progress',
  data: { sessionID, line, done },
})

test('lines are kept per session and the end removes one', () => {
  let lines = apply(new Map(), { sessionID: 'a', line: '1', done: false })
  lines = apply(lines, { sessionID: 'b', line: '2', done: false })
  lines = apply(lines, { sessionID: 'a', line: '3', done: false })
  assert.deepEqual(
    [...lines],
    [
      ['a', '3'],
      ['b', '2'],
    ],
  )
  assert.deepEqual([...apply(lines, { sessionID: 'a', line: 'end', done: true })], [['b', '2']])
})

test('only the session on screen shows its line', () => {
  const lines = new Map([['a', 'craft review: x']])
  assert.equal(shown(lines, { type: 'session', sessionID: 'a' }), '◐ craft review: x')
  assert.equal(shown(lines, { type: 'session', sessionID: 'b' }), '')
  assert.equal(shown(lines, { type: 'home' }), '')
  assert.equal(shown(lines, undefined), '')
})

test('the toast variant follows the verdict', () => {
  assert.equal(variantOf('craft review: Approve'), 'success')
  assert.equal(variantOf('craft review: Approve (INCOMPLETE)'), 'warning')
  assert.equal(variantOf('craft review: Block'), 'error')
  assert.equal(variantOf('review: stopped — aborted'), 'error')
  assert.equal(variantOf('craft review: Warning'), 'warning')
})

test('the plugin subscribes, draws the running line in the footer, and toasts and clears it on the end', () => {
  const f = fakeT()
  const plugin = footerPlugin(solid)
  assert.equal(plugin.id, 'craft.review-footer')
  const cleanup = plugin.setup(/** @type {any} */ (f.t))
  assert.deepEqual(f.defs, [REVIEW_RPC])
  assert.equal(f.slots.length, 1)
  assert.equal(f.slots[0].append, SLOT)
  const el = f.slots[0].render()
  assert.equal(el.tag, 'text')
  assert.equal(el.props.fg, 'grey')
  assert.equal(el.text(), '')
  f.handlers['progress']?.(event('a', 'craft review: review, round 1 — 2 running, 0 done'))
  f.handlers['progress']?.(event('b', 'other session'))
  assert.equal(el.text(), '◐ craft review: review, round 1 — 2 running, 0 done')
  f.handlers['progress']?.(event('a', 'craft review: Approve', true))
  assert.equal(el.text(), '')
  assert.deepEqual(f.toasts, [{ title: 'craft review', message: 'craft review: Approve', variant: 'success', duration: 8000, sessionID: 'a' }])
  cleanup?.()
  assert.equal(f.off(), 1)
})

test('junk events and a broken host cost the line, never a throw', () => {
  const f = fakeT()
  footerPlugin(solid).setup(/** @type {any} */ (f.t))
  const el = f.slots[0].render()
  for (const junk of [null, 1, {}, { data: { sessionID: 'a' } }]) f.handlers['progress']?.(junk)
  assert.equal(el.text(), '')
  f.t.ui.toast.show = () => {
    throw new Error('no toast')
  }
  f.handlers['progress']?.(event('a', 'x'))
  assert.doesNotThrow(() => f.handlers['progress']?.(event('a', 'end', true)))
  assert.equal(footerPlugin(solid).setup(/** @type {any} */ ({})), undefined, 'a t without the surface: no line, no throw')
})
