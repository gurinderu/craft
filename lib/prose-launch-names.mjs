// The prose half of the launch-name check (realm @nick/craft, node #83): a skill or agent body that tells
// the model to launch one of this plugin's workflows or agents must name it as the harness registers it,
// under the plugin prefix. The engine half, and the reading of what the plugin ships, is launch-names.mjs.
/** @typedef {import('./launch-names.mjs').Known} Known */
/** @typedef {import('./launch-names.mjs').Site} Site */

const PROSE = /`(?:([a-z][a-z0-9-]*):)?([a-z][a-z0-9-]*)`\)?\s+(workflow|agent)s?\b/g

/**
 * Every place a skill or agent body names one of this plugin's workflows or agents as the thing to launch:
 * a code-spanned id followed by "workflow"/"agent". Unprefixed, it is a problem; `start`/`end` cover the span.
 * @param {string} text @param {Known} known @returns {Site[]}
 */
export function proseLaunchSites(text, known) {
  /** @type {Site[]} */
  const sites = []
  for (const m of text.matchAll(PROSE)) {
    const [whole, prefix, name = '', word] = m
    const kind = word === 'workflow' ? 'workflow' : 'agent'
    if (prefix !== undefined && prefix !== known.plugin) continue
    if (!(kind === 'workflow' ? known.workflows : known.agents).has(name)) continue
    const span = whole.slice(0, whole.indexOf('`', 1) + 1)
    sites.push({
      kind, line: text.slice(0, m.index).split('\n').length, start: m.index, end: m.index + span.length, text: span,
      problem: prefix === undefined ? `\`${name}\` ${kind} named without the plugin prefix — the harness registers it only as \`${known.plugin}:${name}\`` : null,
    })
  }
  return sites
}
