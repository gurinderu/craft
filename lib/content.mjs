// The review's knowledge as data (realm @nick/craft, node #452): prompt templates in content/prompts/**/*.md and agent answer
// schemas in content/schemas/<name>.schema.json, read by the engines here and by any other implementation of the review
// alike. The build inlines them (lib/engine-bundle.mjs: esbuild's text and json loaders), since the sandbox has no files;
// it names each by its base name, so no two content files share one (lib/engine-bundle-checks.mjs, contentBinding).
//
// A template is plain text with `{{name}}` placeholders, nothing else: no conditionals, no loops, no escapes. What
// is computed — a line present or not, a list joined — is computed by the caller and passed in as a ready string.
// A content file ends with one newline, which is not part of the text.

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g

/** The text of a content file: its final newline dropped. @param {string} raw @returns {string} */
export const contentText = raw => (raw.endsWith('\n') ? raw.slice(0, -1) : raw)

/**
 * `template` with each `{{name}}` replaced by `vars[name]`, in one pass: a value is never itself rendered. Throws on a
 * placeholder `vars` does not name, so a misspelt name fails the first render rather than shipping its braces.
 * @param {string} template  a content file's raw text @param {Record<string, string>} [vars] @returns {string}
 */
export function render(template, vars = {}) {
  return contentText(template).replace(PLACEHOLDER, (_m, /** @type {string} */ name) => {
    const v = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined
    if (v === undefined) throw new Error(`template placeholder {{${name}}} has no value`)
    return v
  })
}

/**
 * A schema with each `{ "$ref": "<file>" }` node replaced by `refs[<file>]`, itself resolved: a schema shared by
 * several answers (a finding) lives in one file and is referenced by name. Throws on a reference `refs` lacks.
 * @param {unknown} node @param {Record<string, unknown>} refs @returns {unknown}
 */
export function resolveRefs(node, refs) {
  if (Array.isArray(node)) return node.map(n => resolveRefs(n, refs))
  if (node === null || typeof node !== 'object') return node
  const ref = /** @type {Record<string, unknown>} */ (node)['$ref']
  if (typeof ref === 'string') {
    if (!Object.prototype.hasOwnProperty.call(refs, ref)) throw new Error(`schema reference ${ref} is not known`)
    return resolveRefs(refs[ref], refs)
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, refs)]))
}
