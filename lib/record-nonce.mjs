// The nonce a logger prompt carries so the logger script can find that prompt in its agent's own transcript
// and read the record from there, instead of the model copying it (realm @nick/craft, node #429). The engine
// stamps it inside the Workflow sandbox — no clock, no randomness — and craft-log-run recomputes it over the
// record it read, so a transcript that holds another prompt's record is refused, never filed. Same record,
// command, phase, retry and attempt give the same nonce; the engine numbers each dispatch of one record
// (`attempt`), so no two of its prompts share one. Two prompts that do are ambiguous, and the script refuses an
// ambiguity too (lib/transcript-record.mjs).

const NONCE_PREFIX = 'craft-'
// The line craft-log-run opens when `--from-transcript` found no sure record: nothing was written.
export const TRANSCRIPT_MISS = 'craft-log-run TRANSCRIPT-MISS'
export const NONCE_RE = /^craft-[0-9a-f]{16}$/

// 32-bit FNV-1a over the UTF-16 code units of `text`, from `basis`.
/** @param {string} text @param {number} basis @returns {string} */
function fnv1a(text, basis) {
  let h = basis >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The nonce of one logger call: two FNV-1a passes from different bases, 64 bits in all.
 * @param {unknown} record  the payload as the prompt carries it (compared as `JSON.stringify` gives it)
 * @param {{ command: string, phase?: string, retry?: boolean, attempt?: number | undefined }} call
 * @returns {string}
 */
export function recordNonce(record, { command, phase: phaseTitle = '', retry = false, attempt = 0 }) {
  // `phaseTitle`, not `phase`: the engines bundle this, and `phase` is a sandbox global.
  const text = `${command}\u0000${phaseTitle}\u0000${retry ? 'retry' : ''}\u0000${attempt}\u0000${JSON.stringify(record) ?? ''}`
  return `${NONCE_PREFIX}${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x050c5d1f)}`
}

// The `--attempt` flag that carries a dispatch's number to the script, which recomputes the nonce with it;
// none for the first (0, or none given).
/** @param {number | undefined} attempt @returns {string} */
export function attemptFlag(attempt) {
  return attempt ? `--attempt ${attempt} ` : ''
}
