// The TUI side of the review's footer line on OpenCode 2.x (realm @nick/craft, node #512): a TUI plugin that hears the
// `craft.review` RPC's `progress` (review-rpc.mjs), keeps one line per calling session, draws the line of the session
// on screen in the prompt's footer, and on the end shows a toast and clears the line. The surface — `t.client.rpc`,
// `t.ui.slot` on `prompt.footer.status`, `t.ui.toast`, `t.ui.router.current()` — as observed on opencode 2.2.7
// (node #503); the host supplies @opentui/solid and solid-js, which tui/tui.mjs hands in, so this module imports
// neither and runs under test. It never throws into the host: any failure costs the line, nothing else.
import { asProgress, PROGRESS, REVIEW_RPC } from './review-rpc.mjs'

/** @typedef {import('./review-rpc.mjs').ReviewProgress} ReviewProgress */
/** @typedef {ReadonlyMap<string, string>} Lines  the running line per session */
/**
 * What the host's UI runtime gives this module: an element, a reactive child, a reactive property, a signal.
 * @typedef {{
 *   createElement(tag: string): unknown,
 *   insert(el: unknown, value: () => string): void,
 *   setProp(el: unknown, name: string, value: unknown): void,
 *   effect(fn: () => void): void,
 *   createSignal<T>(value: T): [() => T, (value: T) => void],
 * }} Solid
 */
/** @typedef {{ type?: string, sessionID?: string }} Route */
/**
 * The part of the TUI plugin's `t` used here.
 * @typedef {{
 *   client: { rpc(definition: typeof REVIEW_RPC): { events: { on(name: string, cb: (event: unknown) => void): unknown } } },
 *   ui: {
 *     slot(slot: { append: string, render: () => unknown }): unknown,
 *     toast: { show(toast: { title: string, message: string, variant: string, duration: number, sessionID: string }): unknown },
 *     router: { current(): Route },
 *   },
 *   theme: { text: { muted: unknown } },
 * }} Tui
 */

export const SLOT = 'prompt.footer.status'
const TOAST_MS = 8000

/** The lines after `p`: a running line replaces the session's, the end removes it. @param {Lines} lines @param {ReviewProgress} p @returns {Lines} */
export function apply(lines, p) {
  const next = new Map(lines)
  if (p.done) next.delete(p.sessionID)
  else next.set(p.sessionID, p.line)
  return next
}

/** The line to draw on `route`: the running line of the session on screen, or none. @param {Lines} lines @param {Route | undefined} route */
export function shown(lines, route) {
  const line = route?.type === 'session' && route.sessionID ? lines.get(route.sessionID) : undefined
  return line ? `◐ ${line}` : ''
}

/** The toast's variant for an end line, by the verdict it names. @param {string} line */
export function variantOf(line) {
  if (/\bBlock\b|stopped/.test(line)) return 'error'
  return /\bApprove\b/.test(line) && !line.includes('INCOMPLETE') ? 'success' : 'warning'
}

/** `fn()`, or `fallback` when it throws. @template T @param {() => T} fn @param {T} fallback @returns {T} */
const guarded = (fn, fallback) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** The footer's text element, its text following `text`. @param {Solid} solid @param {Tui} t @param {() => string} text */
function footerText(solid, t, text) {
  const el = solid.createElement('text')
  solid.insert(el, text)
  solid.effect(() => {
    guarded(() => {
      solid.setProp(el, 'fg', t.theme.text.muted)
    }, undefined)
  })
  return el
}

/** Wires the footer into `t`; returns the unsubscriber. @param {Solid} solid @param {Tui} t */
function wire(solid, t) {
  const [lines, setLines] = solid.createSignal(/** @type {Lines} */ (new Map()))
  const route = () => guarded(() => t.ui.router.current(), undefined)
  t.ui.slot({ append: SLOT, render: () => footerText(solid, t, () => shown(lines(), route())) })
  /** @param {unknown} event */
  const hear = event => {
    const p = asProgress(guarded(() => /** @type {{ data?: unknown }} */ (event).data, undefined)) ?? asProgress(event)
    if (!p) return
    setLines(apply(lines(), p))
    if (p.done) {
      guarded(
        () => t.ui.toast.show({ title: 'craft review', message: p.line, variant: variantOf(p.line), duration: TOAST_MS, sessionID: p.sessionID }),
        undefined,
      )
    }
  }
  const off = t.client.rpc(REVIEW_RPC).events.on(PROGRESS, event => guarded(() => hear(event), undefined))
  return typeof off === 'function' ? /** @type {() => void} */ (off) : undefined
}

/** The TUI plugin module's default export, on the host's `solid`. @param {Solid} solid */
export function footerPlugin(solid) {
  return {
    id: 'craft.review-footer',
    /** @param {Tui} t */
    setup(t) {
      const off = guarded(() => wire(solid, t), undefined)
      return off ? () => guarded(off, undefined) : undefined
    },
  }
}
