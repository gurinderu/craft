// The inline PR comment the review engine posts for a Confirmed finding, and its reading back. The
// marker and the `[Severity] title` first line are what lets a later session tie a reply in that
// thread to the finding it answers (lib/pr-rejections.mjs): a comment without them is not craft's,
// and nothing is recorded from it. Inlined into src/review.js (no imports here).

// An HTML comment: invisible on the PR page, present in the body the API returns.
export const FINDING_COMMENT_MARKER = '<!-- craft-finding -->'
// The lens that raised the finding, as a hidden line beside the marker, so a rejection recorded from the
// thread carries the finding's anchor (realm @nick/craft, node #230). Lens names only: letters, digits, `-`, `_`, `,`, `:`, `/`, `.`, space (one line).
export const LENS_LINE = /^<!-- craft-lens: ([A-Za-z0-9_,:/. -]{1,80}) -->$/m

/** @param {unknown} v */
export function commentLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The comment body for one finding: `[Severity] title`, the reason and the fix, the lens line when the
 * finding names a lens fit for it (`source`), the marker.
 * @param {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown, source?: unknown }} f @returns {string}
 */
export function findingCommentBody(f) {
  const lens = `<!-- craft-lens: ${commentLine(f.source)} -->`
  return `[${commentLine(f.severity)}] ${commentLine(f.title)}\n\n${String(f.why ?? '').trim()} — ${String(f.fix ?? '').trim()}\n\n${LENS_LINE.test(lens) ? `${lens}\n` : ''}${FINDING_COMMENT_MARKER}`
}

/**
 * The finding a comment body carries, or null when the body is not a craft finding comment (no
 * marker, or a first line that is not `[Severity] title`); `lens` only when the body carries its line.
 * @param {unknown} body @returns {{ severity: string, title: string, lens?: string } | null}
 */
export function readFindingComment(body) {
  const text = String(body ?? '')
  if (!text.includes(FINDING_COMMENT_MARKER)) return null
  const m = /^\[(Critical|High|Medium|Low|Info)\] (\S.*)$/i.exec(text.split('\n')[0]?.trim() ?? '')
  const lens = LENS_LINE.exec(text)?.[1]?.trim()
  return m ? { severity: String(m[1]), title: String(m[2]).trim(), ...(lens ? { lens } : {}) } : null
}
