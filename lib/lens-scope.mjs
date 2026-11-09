// Two small pure helpers left from the review engine's diff slicing (the slicing itself is the craft binary's now):
// the files whose relation to everything else is the point, and UTF-8 encoding for the Workflow sandbox.

// Files whose relation to everything else is the point — a manifest, a lockfile, a schema: a slice of the
// diff that cannot see them cannot tell what the rest is checked against (lib/unit-boundary.mjs lists their
// reads apart, never as a unit's violation).
export const SHARED_SUFFIXES = ['.lock', '.yml', '.yaml', '.toml', '.json']

/** @param {string} file */
export function isShared(file) {
  return SHARED_SUFFIXES.some(s => file.endsWith(s))
}

// UTF-8 by hand. The Workflow sandbox has no TextEncoder or TextDecoder — a probe workflow saw both
// undefined (realm @nick/craft, #135). This follows the platform object: a lone surrogate encodes as
// U+FFFD (pinned against TextEncoder by a differential test).
/** @param {string} text @returns {number[]} */
export function utf8Bytes(text) {
  /** @type {number[]} */
  const out = []
  for (const ch of text) {
    let cp = /** @type {number} */ (ch.codePointAt(0))
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return out
}
