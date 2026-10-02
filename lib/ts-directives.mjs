// The comments that switch the type check off, read from TypeScript's own scan of the file rather
// than a regex over lines. A line regex saw only a directive opening its line, yet tsc honours
// `x // @ts-ignore` and `x /* @ts-ignore */` just as well. It also caught words tsc ignores. The
// parser keeps two records that the checker reads when it suppresses: `commentDirectives` (each
// @ts-ignore / @ts-expect-error, line or block, leading or trailing) and `checkJsDirective` (the
// file's leading `// @ts-nocheck` pragma). Neither is in the public typings, so a TypeScript that
// stops keeping them fails the check loudly rather than reading as directive-free.
/** @typedef {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} SourceFile */
/** @typedef {{ pos: number, end: number }} Range */
/** @typedef {{ commentDirectives?: { range: Range }[], checkJsDirective?: Range & { enabled: boolean } }} Records */

/**
 * Each directive tsc honours in `sf` (parsed as a file of its own), by line; null when this
 * TypeScript keeps no record to read them from.
 * @param {SourceFile} sf @returns {{ line: number, directive: string }[] | null}
 */
export function directiveSites(sf) {
  if (!('commentDirectives' in sf) || !('checkJsDirective' in sf)) return null
  const rec = /** @type {Records} */ (/** @type {unknown} */ (sf))
  /** @type {{ pos: number, directive: string }[]} */
  const found = (rec.commentDirectives ?? []).map(d => ({
    pos: d.range.pos,
    // The range holds the directive by construction: the scanner records it only on a match.
    directive: sf.text.slice(d.range.pos, d.range.end).includes('@ts-expect-error') ? '@ts-expect-error' : '@ts-ignore',
  }))
  const js = rec.checkJsDirective
  if (js && !js.enabled) found.push({ pos: js.pos, directive: '@ts-nocheck' })
  return found
    .sort((a, b) => a.pos - b.pos)
    .map(({ pos, directive }) => ({ line: sf.getLineAndCharacterOfPosition(pos).line + 1, directive }))
}

/**
 * An engine may not switch the check off, as an inlined lib module may not (typedScopeProblems).
 * @param {SourceFile} sf  the engine, parsed on its own @param {string} file  its repo path @returns {string[]}
 */
export function directiveProblems(sf, file) {
  const sites = directiveSites(sf)
  if (!sites) return [`${file}: this TypeScript keeps no record of comment directives — a @ts-ignore in it would go unseen`]
  return sites.map(s => `${file}:${s.line} switches the type check off with ${s.directive}`)
}
