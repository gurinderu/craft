// Every file and line in the run store is a JSON object, and every reader dereferences its fields.
// Valid JSON that is not an object (`null`, a number, an array) passed the parse-error handling each
// reader already has and then crashed it — one stray file aborted recovery, a backfill halfway, or a
// prior-round lookup. Readers parse through this instead, so a non-object takes the same path a parse
// error already takes (skip, quarantine, mark unreadable) at each of them.
/**
 * @param {string} text
 * @returns {any} the parsed object; its field types are the caller's to declare, as with `JSON.parse`
 * @throws {SyntaxError} when `text` is not JSON, or is JSON that is not a plain object
 */
export function parseJsonObject(text) {
  const v = JSON.parse(text)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('not a JSON object')
  return v
}
