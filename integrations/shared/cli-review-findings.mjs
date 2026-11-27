// The answer's `## Findings` list, one line per reported finding: severity, `file:line`, title and tier, as the binary's
// finished step names them. The unverified Low and Info findings the binary held apart are left out, one sentence naming
// how many and the file they are in (realm @nick/craft, node #636), as the binary's own driver writes it
// (cli/bin/craft/src/run/findings.rs); a parent reading the list (rust-audit, the hosts' review summary) reads that
// sentence back by HELD_APART.

/** @typedef {import('./cli-review-record.mjs').Finding} Finding */

/** @param {unknown} v @returns {string} */
export const oneLine = v =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()

/** The sentence naming the held findings, its count and file captured. */
export const HELD_APART = /^(\d+) Low or Info finding\(s\) no verifier checked are not listed: they are in (.+)\.$/

/** Whether `f` is a finding the binary holds apart: unverified, at Low or Info severity. @param {Finding} f */
const isHeld = f => f.tier === 'unverified' && (f.severity === 'Low' || f.severity === 'Info')

/** @param {Finding} f @returns {string} */
const row = f =>
  `- [${oneLine(f.severity) || 'unrated'}] ${oneLine(f.file)}${f.line ? `:${f.line}` : ''} — ${oneLine(f.title)}${f.tier ? ` (${oneLine(f.tier)})` : ''}`

/**
 * The list over a finished step's findings and what it held apart (`held`, null when nothing).
 * @param {Finding[]} findings @param {{ count: number, file: string } | null} [held] @returns {string}
 */
export function findingsList(findings, held = null) {
  const rows = findings.filter(f => !held || !isHeld(f)).map(row)
  const apart = held ? [`${String(held.count)} Low or Info finding(s) no verifier checked are not listed: they are in ${oneLine(held.file)}.`] : []
  const body = [...rows, ...apart]
  return ['## Findings', '', ...(body.length ? body : ['None reported.'])].join('\n')
}
