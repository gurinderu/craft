// What the Workflow sandbox does NOT provide, observed with a probe workflow (realm @nick/craft, #135):
// TextEncoder, TextDecoder, process and require are undefined there. One list, read by the engine
// harness (which shadows each name) and by check-workflows (which refuses each name in inlined code —
// that code is type-checked in its lib module against Node typings, where every one of them exists).
export const SANDBOX_ABSENT = ['TextEncoder', 'TextDecoder', 'process', 'require']

/**
 * The code of a JS text with comments and string literals blanked (newlines kept, so line numbers
 * hold); a template literal's `${…}` stays code.
 * @param {string} text @returns {string}
 */
export function codeOnly(text) {
  let out = ''
  /** @type {string[]} */
  const stack = []   // open contexts: '`' a template body, '{' a brace inside `${…}` or plain code
  for (let i = 0; i < text.length; i++) {
    const c = /** @type {string} */ (text[i])
    const top = stack[stack.length - 1]
    if (top === '`') {
      if (c === '\\') { out += '  '; i++; continue }
      if (c === '`') { stack.pop(); out += ' '; continue }
      if (c === '$' && text[i + 1] === '{') { stack.push('${'); out += '  '; i++; continue }
      out += c === '\n' ? '\n' : ' '
      continue
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop - 1
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      out += ' '.repeat(Math.min(j, text.length - 1) - i + 1)
      i = j
      continue
    }
    if (c === '`') { stack.push('`'); out += ' '; continue }
    if (c === '{') stack.push('{')
    else if (c === '}') {
      if (top === '${') { stack.pop(); out += ' '; continue }
      if (top === '{') stack.pop()
    }
    out += c
  }
  return out
}

/**
 * Each use of a SANDBOX_ABSENT name as code (not a property: `x.process` is fine).
 * @param {string} text @returns {{ line: number, name: string }[]}
 */
export function absentGlobalUses(text) {
  const re = new RegExp(`(?<![.\\w$])(${SANDBOX_ABSENT.join('|')})(?![\\w$])`, 'g')
  /** @type {{ line: number, name: string }[]} */
  const out = []
  codeOnly(text).split('\n').forEach((l, i) => {
    for (const m of l.matchAll(re)) out.push({ line: i + 1, name: /** @type {string} */ (m[1]) })
  })
  return out
}
