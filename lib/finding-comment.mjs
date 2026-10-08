// The inline PR comment the review engine posts for a Confirmed finding, and its reading back. The
// marker and the `[Severity] title` first line are what lets a later session tie a reply in that
// thread to the finding it answers (lib/pr-rejections.mjs): a comment without them is not craft's,
// and nothing is recorded from it. Inlined into src/review.js (no imports here).

// An HTML comment: invisible on the PR page, present in the body the API returns.
export const FINDING_COMMENT_MARKER = '<!-- craft-finding -->'
// The lens that raised the finding, as a hidden line beside the marker, so a rejection recorded from the
// thread carries the finding's anchor (realm @nick/craft, node #230). Lens names only: letters, digits, `-`, `_`, `,`, `:`, `/`, `.`, space (one line).
export const LENS_LINE = /^<!-- craft-lens: ([A-Za-z0-9_,:/. -]{1,80}) -->$/m
// The rule the finding fired (its `ruleId`), as a hidden line beside the lens, so a rejection recorded
// from the thread of a gate tool's finding carries it too (realm @nick/craft, node #236). Rule ids
// only: letters, digits, `-`, `_`, `:`, `/`, `.`, `@`, `#` (one line, no space).
export const RULE_LINE = /^<!-- craft-rule: ([A-Za-z0-9_:/.@#-]{1,120}) -->$/m

/** @param {unknown} v */
export function commentLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The comment body for one finding: `[Severity] title`, the reason and the fix, the lens line when the
 * finding names a lens fit for it (`source`), the rule line when it names a rule id fit for it
 * (`ruleId`), the marker.
 * @param {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown, source?: unknown, ruleId?: unknown }} f @returns {string}
 */
export function findingCommentBody(f) {
  const lens = `<!-- craft-lens: ${commentLine(f.source)} -->`
  const rule = `<!-- craft-rule: ${commentLine(f.ruleId)} -->`
  return `[${commentLine(f.severity)}] ${commentLine(f.title)}\n\n${String(f.why ?? '').trim()} — ${String(f.fix ?? '').trim()}\n\n${LENS_LINE.test(lens) ? `${lens}\n` : ''}${RULE_LINE.test(rule) ? `${rule}\n` : ''}${FINDING_COMMENT_MARKER}`
}

/**
 * The finding a comment body carries, or null when the body is not a craft finding comment (no
 * marker, or a first line that is not `[Severity] title`); `lens` and `ruleId` only when the body
 * carries their lines.
 * @param {unknown} body @returns {{ severity: string, title: string, lens?: string, ruleId?: string } | null}
 */
export function readFindingComment(body) {
  const text = String(body ?? '')
  if (!text.includes(FINDING_COMMENT_MARKER)) return null
  const m = /^\[(Critical|High|Medium|Low|Info)\] (\S.*)$/i.exec(text.split('\n')[0]?.trim() ?? '')
  return m ? { severity: String(m[1]), title: String(m[2]).trim(), ...hiddenLine('lens', LENS_LINE, text), ...hiddenLine('ruleId', RULE_LINE, text) } : null
}

/** `{ [k]: value }` of the hidden line `re` matches in `text`, or `{}` when it has none. @param {string} k @param {RegExp} re @param {string} text @returns {Record<string, string>} */
export function hiddenLine(k, re, text) {
  const v = re.exec(text)?.[1]?.trim()
  return v ? { [k]: v } : {}
}
