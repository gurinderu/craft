// The fields of a finished step the `craft` binary prints, each checked and defaulted the one way the cli-review driver
// and the run-record adapter read them (lib/cli-review-step.mjs, finishedStep): its findings, its stop, its round and
// ledger, what it published and what its lenses yielded.

/** @typedef {import('./cli-review-record.mjs').Finding} Finding */
/** @typedef {import('./cli-review-record.mjs').LedgerRow} LedgerRow */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
/** @param {unknown} v @returns {string} */
export const stepText = v => (typeof v === 'string' ? v : '')
/** @param {unknown} v @returns {string[]} */
export const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

/** A finished step's reported findings, as its run record keeps them. @param {unknown} v @returns {Finding[]} */
export const findingsOf = v => (Array.isArray(v) ? v.filter(isObject) : []).map(f => ({
  severity: String(f['severity'] ?? ''), file: String(f['file'] ?? ''), line: Number.isInteger(f['line']) ? Number(f['line']) : 0,
  title: String(f['title'] ?? ''), ruleId: String(f['ruleId'] ?? ''), tier: String(f['tier'] ?? ''),
}))

/**
 * The binary's stop as a parent reads it back from the answer (lib/limit-report.mjs: limitInReport, deathsInReport),
 * '' when the run did not stop.
 * @param {unknown} s @returns {string}
 */
export function stopNoteOf(s) {
  if (!isObject(s) || typeof s['text'] !== 'string' || !s['text']) return ''
  if (s['cause'] === 'limit') return `stopped: usage limit reached (${s['text']})`
  return s['cause'] === 'deaths' ? `stopped: ${s['text']}` : ''
}

/**
 * What the next round of the branch needs from a finished step: its round, its ledger, how it built on the last.
 * A round that reviewed only the fix commits is `delta`, so no reader takes it for coverage of the whole diff at its head.
 * @param {Record<string, unknown>} v @returns {{ round: number, lensScope: 'delta' | 'full', ledger: LedgerRow[] | null, reReview: Record<string, unknown> | null }}
 */
export const roundOf = v => ({
  round: Number.isInteger(v['round']) && Number(v['round']) > 0 ? Number(v['round']) : 1,
  lensScope: v['lensScope'] === 'delta' ? 'delta' : 'full',
  ledger: Array.isArray(v['ledger']) ? v['ledger'].filter(isObject).map(ledgerRowOf) : null,
  reReview: isObject(v['reReview']) ? v['reReview'] : null,
})

/**
 * What a finished step says of publishing on the PR: the sorting, the findings going against memory and what was posted,
 * each null when the binary sent none.
 * @param {Record<string, unknown>} v
 */
export const publicationOf = v => ({
  sorting: isObject(v['sorting']) ? v['sorting'] : null,
  memoryContradictions: isObject(v['memoryContradictions']) ? v['memoryContradictions'] : null,
  prComments: isObject(v['prComments']) ? v['prComments'] : null,
})

/**
 * What a finished step says its lenses yielded and its verification judged, in the engine's record shape: the rows,
 * `[]` when it sent none; the verification and the lens rounds, null when it sent none.
 * @param {Record<string, unknown>} v
 */
export const telemetryOf = v => ({
  dimensions: Array.isArray(v['dimensions']) ? v['dimensions'].filter(isObject) : [],
  verification: isObject(v['verification']) ? v['verification'] : null,
  lensRounds: Array.isArray(v['lensRounds']) ? v['lensRounds'].filter(isObject) : null,
})

/** One row of the binary's ledger, its fields as strings and its line a number. @param {Record<string, unknown>} r @returns {LedgerRow} */
const ledgerRowOf = r => ({
  file: stepText(r['file']), line: Number.isInteger(r['line']) ? Number(r['line']) : 0, symbol: stepText(r['symbol']),
  severity: stepText(r['severity']), tier: stepText(r['tier']), disposition: stepText(r['disposition']) || 'open',
  source: stepText(r['source']), ruleId: stepText(r['ruleId']), title: stepText(r['title']), why: stepText(r['why']),
  ...(stepText(r['toolRule']) ? { toolRule: stepText(r['toolRule']) } : {}),
  ...(Array.isArray(r['sources']) ? { sources: r['sources'] } : {}),
  ...(isObject(r['deferral']) ? { deferral: r['deferral'] } : {}),
})
