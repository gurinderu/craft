// The inline PR comment the review engine posts for a Confirmed finding, and its reading back. The
// marker and the `[Severity] title` first line are what lets a later session tie a reply in that
// thread to the finding it answers (lib/pr-rejections.mjs): a comment without them is not craft's,
// and nothing is recorded from it. Inlined into workflows/review.js (no imports here).

// An HTML comment: invisible on the PR page, present in the body the API returns.
export const FINDING_COMMENT_MARKER = '<!-- craft-finding -->'

/** @param {unknown} v */
export function commentLine(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The comment body for one finding: `[Severity] title`, the reason and the fix, the marker.
 * @param {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown }} f @returns {string}
 */
export function findingCommentBody(f) {
  return `[${commentLine(f.severity)}] ${commentLine(f.title)}\n\n${String(f.why ?? '').trim()} — ${String(f.fix ?? '').trim()}\n\n${FINDING_COMMENT_MARKER}`
}

/**
 * The finding a comment body carries, or null when the body is not a craft finding comment (no
 * marker, or a first line that is not `[Severity] title`).
 * @param {unknown} body @returns {{ severity: string, title: string } | null}
 */
export function readFindingComment(body) {
  const text = String(body ?? '')
  if (!text.includes(FINDING_COMMENT_MARKER)) return null
  const m = /^\[(Critical|High|Medium|Low|Info)\] (\S.*)$/i.exec(text.split('\n')[0]?.trim() ?? '')
  return m ? { severity: String(m[1]), title: String(m[2]).trim() } : null
}
