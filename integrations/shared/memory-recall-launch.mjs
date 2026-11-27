// The launch-side reading of the project memory the triage engine ran before the craft binary took the triage over
// (realm @nick/craft, node #616): the launcher's `priorDecisions` read at launch (readLaunch) and merged with a recall's
// answer (mergeRecall), each composed of memory-recall.mjs's live parts — mergeAndRead, parseMerged, acceptedMemory,
// withPassed, withDerived — which rust-audit still runs. Only the tests of those parts' rules reach this module: it
// holds the compositions they are pinned through, and ships nowhere.
import { initialMemory, kindCounts, mergeAndRead, parseMerged, withDerived, withPassed } from './memory-recall.mjs'

/** @typedef {import('./memory-recall.mjs').MemorySource} MemorySource @typedef {import('./memory-recall.mjs').InactiveRecord} InactiveRecord */
/**
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @typedef {import('./memory-recall.mjs').ParseDecisions<D>} ParseDecisions
 */

/**
 * The recall's answer merged RAW with the launcher's `priorDecisions` (mergeAndRead), read once by
 * `parse` (parsePriorDecisions) under its one cap: the decisions to apply, every refusal (a launcher's
 * argument that is no list still named), the refusals not already logged at launch (the recall's and
 * the cap's, and the passed records an inactive one holds back), and the source — its new count the
 * launcher's records applied that the recall did not hold, its why naming each newer passed record
 * applied over an inactive one.
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {{ decisions: unknown[], memory: MemorySource, inactive?: InactiveRecord[] }} r @param {unknown} passedRaw @param {ParseDecisions<D>} parse
 * @returns {{ prior: { decisions: D[], refused: string[] }, recalledRefused: string[], memory: MemorySource }}
 */
export function mergeRecall(r, passedRaw, parse) {
  const alone = parse(passedRaw)
  const { read: m, blocked, overrides } = mergeAndRead(r.decisions, Array.isArray(passedRaw) ? /** @type {unknown[]} */ (passedRaw) : [], parse, r.inactive)
  const memory = withDerived(withPassed(acceptedMemory(r.memory, m.recalled), alone.decisions.length, m.passed), m.prior.decisions)
  return {
    prior: { decisions: m.prior.decisions, refused: [...(Array.isArray(passedRaw) ? [] : alone.refused), ...m.prior.refused, ...blocked] },
    recalledRefused: [...m.prior.refused.filter(x => !x.startsWith('passed decision #')), ...blocked],
    memory: overrides.length ? { ...memory, why: `${memory.why}; ${overrides.join('; ')}` } : memory,
  }
}

/**
 * The `priorDecisions` argument read at launch, and the source before any recall. A launcher that
 * already recalled and says how its list splits (`partsArg`) gets each refusal and the memory line
 * named by part; otherwise the list is read as one.
 * @template {{ id: string, kind?: string, derived?: boolean }} D
 * @param {unknown} raw @param {boolean} recalled `_recalled` @param {unknown} note `_memory` @param {unknown} partsArg `_memoryParts`
 * @param {ParseDecisions<D>} parse @returns {{ prior: { decisions: D[], refused: string[] }, memory: MemorySource }}
 */
export function readLaunch(raw, recalled, note, partsArg, parse) {
  const parts = recalled ? memoryParts(partsArg, raw) : null
  if (!parts) {
    const prior = parse(raw)
    return { prior, memory: withDerived(acceptedMemory(initialMemory(prior.decisions.length, recalled, note), prior.decisions), prior.decisions) }
  }
  const m = parseMerged(/** @type {unknown[]} */ (raw), parts.recalled, parse)
  return {
    prior: m.prior,
    memory: withDerived(withPassed(acceptedMemory(initialMemory(0, true, note), m.prior.decisions), parts.accepted ?? 0, m.passed), m.prior.decisions),
  }
}

/**
 * How a launching audit's forwarded list splits (`_memoryParts`): the first `recalled` records its
 * recall's, the next `passed` its launcher's; `accepted`, the launcher's records the audit's reader
 * accepted — the K its own memory line prints, so the nested line counts the same, and without it the
 * line names no K (realm @nick/craft, node #244). Anything off-shape, or not adding up to the list, is
 * ignored; an off-shape `accepted` alone.
 * @param {unknown} parts @param {unknown} list @returns {{ recalled: number, passed: number, accepted?: number } | null}
 */
export function memoryParts(parts, list) {
  const p = /** @type {Record<string, unknown>} */ (parts && typeof parts === 'object' ? parts : {})
  const [a, b, k] = [partCount(p['recalled']), partCount(p['passed']), partCount(p['accepted'])]
  if (!Array.isArray(list) || a == null || b == null || a + b !== list.length) return null
  return k == null ? { recalled: a, passed: b } : { recalled: a, passed: b, accepted: k }
}

/** A count of `_memoryParts`: a non-negative integer, else null. @param {unknown} x @returns {number | null} */
export function partCount(x) {
  return Number.isInteger(x) && /** @type {number} */ (x) >= 0 ? /** @type {number} */ (x) : null
}

/**
 * A recalled source (by this engine or the launching one) once parsePriorDecisions read its list: the
 * count is the records it accepted, the questions among them counted apart; the refused are named in their own section.
 * @param {MemorySource} m @param {Array<{ kind?: string }>} accepted @returns {MemorySource}
 */
export function acceptedMemory(m, accepted) {
  if (m.source === 'none') return m
  /** @type {MemorySource} */
  const out = { ...m, count: accepted.length }
  delete out.questions
  delete out.rules
  return { ...out, ...kindCounts(accepted.filter(d => d.kind === 'question').length, accepted.filter(d => d.kind === 'rule').length) }
}
