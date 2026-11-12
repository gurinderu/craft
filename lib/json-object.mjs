// Every file and line in the run store is a JSON object, and every reader dereferences its fields.
// Valid JSON that is not an object (`null`, a number, an array) passed the parse-error handling each
// reader already has and then crashed it — one stray file aborted recovery, a backfill halfway, or a
// prior-round lookup. Readers parse through this instead, so a non-object takes the same path a parse
// error already takes (skip, quarantine, mark unreadable) at each of them.
/**
 * @template [T=any]  the shape the caller declares for the object's fields, as with `JSON.parse`; read from the
 *   type the result is assigned to
 * @param {string} text
 * @returns {T} the parsed object
 * @throws {SyntaxError} when `text` is not JSON, or is JSON that is not a plain object
 */
export function parseJsonObject(text) {
  /** @type {unknown} */
  const v = JSON.parse(text)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('not a JSON object')
  return /** @type {T} */ (v)
}

/**
 * JSON text as the shape its caller declares: `JSON.parse` without its `any`, the declared type read from the
 * type the result is assigned to. No check: the caller narrows what it does not trust.
 * @template [T=unknown]
 * @param {string} text
 * @returns {T}
 * @throws {SyntaxError} when `text` is not JSON
 */
export function parseJson(text) {
  /** @type {unknown} */
  const v = JSON.parse(text)
  return /** @type {T} */ (v)
}
