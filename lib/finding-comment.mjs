// The inline PR comment the review engine posts for a Confirmed finding, and its reading back. The
// marker and the `[Severity] title` first line are what lets a later session tie a reply in that
// thread to the finding it answers (lib/pr-rejections.mjs): a comment without them is not craft's,
// and nothing is recorded from it. Inlined into src/review.js (no imports here).

// An HTML comment: invisible on the PR page, present in the body the API returns.
export const FINDING_COMMENT_MARKER = '<!-- craft-finding -->'
// The lens that raised the finding, as a hidden line beside the marker, so a rejection recorded from the
// thread carries the finding's anchor (realm @nick/craft, node #230). Lens names only: letters, digits, `-`, `_`, `,`, `:`, `/`, `.`, space (one line).
export const LENS_LINE = /^<!-- craft-lens: ([A-Za-z0-9_,:/. -]{1,80}) -->$/m
// The gate tool's own rule the finding fired (its `toolRule` — a clippy lint, a semgrep rule id…), as a
// hidden line beside the lens, so a rejection recorded from the thread of a gate tool's finding carries
// it too (realm @nick/craft, node #236). Rule names only: letters, digits, `-`, `_`, `:`, `/`, `.`, `@`, `#` (one line, no space).
export const TOOL_RULE_LINE = /^<!-- craft-tool-rule: ([A-Za-z0-9_:/.@#-]{1,120}) -->$/m
// A comment of the second kind — a question to the author, not a defect (realm @nick/craft, node #271) —
// carries this hidden line; a comment without it is a defect. The marker stays the last line either way,
// so a question's thread is read back like any finding's (lib/pr-rejections.mjs).
export const KIND_LINE = /^<!-- craft-kind: (question) -->$/m
// What a question comment asks, visibly, under its first line.
export const QUESTION_ASK = '**Question to the author:** is this a defect here, or intended? It turns on something you know — reply with the reason ("not a bug: …", "by design: …"), or fix it.'

/** @param {unknown} v */
export function commentLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The comment body for one finding: `[Severity] title`, for a question the ask, the reason and the fix,
 * the lens line when the finding names a lens fit for it (`source`), the rule line when it names a rule id
 * fit for it (`toolRule`, the gate tool's own rule name), for a question the kind line, the marker.
 * @param {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown, source?: unknown, toolRule?: unknown }} f
 * @param {'defect' | 'question'} [kind] @returns {string}
 */
export function findingCommentBody(f, kind = 'defect') {
  const lens = `<!-- craft-lens: ${commentLine(f.source)} -->`
  const rule = `<!-- craft-tool-rule: ${commentLine(f.toolRule)} -->`
  const question = kind === 'question'
  return `[${commentLine(f.severity)}] ${commentLine(f.title)}\n\n${question ? `${QUESTION_ASK}\n\n` : ''}${String(f.why ?? '').trim()} — ${String(f.fix ?? '').trim()}\n\n${LENS_LINE.test(lens) ? `${lens}\n` : ''}${TOOL_RULE_LINE.test(rule) ? `${rule}\n` : ''}${question ? '<!-- craft-kind: question -->\n' : ''}${FINDING_COMMENT_MARKER}`
}

/**
 * The finding a comment body carries, or null when the body is not a craft finding comment (no
 * marker, or a first line that is not `[Severity] title`); `lens`, `toolRule` and `kind` (a question) only
 * when the body carries their lines.
 * @param {unknown} body @returns {{ severity: string, title: string, lens?: string, toolRule?: string, kind?: string } | null}
 */
export function readFindingComment(body) {
  const text = String(body ?? '')
  if (!text.includes(FINDING_COMMENT_MARKER)) return null
  const m = /^\[(Critical|High|Medium|Low|Info)\] (\S.*)$/i.exec(text.split('\n')[0]?.trim() ?? '')
  return m ? { severity: String(m[1]), title: String(m[2]).trim(), ...hiddenLine('lens', LENS_LINE, text), ...hiddenLine('toolRule', TOOL_RULE_LINE, text), ...hiddenLine('kind', KIND_LINE, text) } : null
}

/** `{ [k]: value }` of the hidden line `re` matches in `text`, or `{}` when it has none. @param {string} k @param {RegExp} re @param {string} text @returns {Record<string, string>} */
export function hiddenLine(k, re, text) {
  const v = re.exec(text)?.[1]?.trim()
  return v ? { [k]: v } : {}
}
