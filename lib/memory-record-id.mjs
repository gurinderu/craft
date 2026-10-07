// The memory skill's record id (skills/memory, "Record shape"): `<kind>-` + the first 10 hex chars of
// sha256("<kind>\n<title>\n<scope>"), the title trimmed, inner whitespace collapsed and lower-cased,
// the scope without a leading `./` or trailing `/`. A review engine derives it for a record that comes
// without one (realm @nick/craft, node #222), so sha256 is computed here in plain JS: the Workflow
// sandbox has no crypto, no TextEncoder and no Node API. Tested against node:crypto.
// Inlined into src/review.js, src/adversarial-review.js and src/rust-audit.js (no imports: the sandbox
// has no module system), after utf8Bytes from lib/lens-scope.mjs; lib/pr-thread-rule.mjs uses the same rule.
import { utf8Bytes } from './lens-scope.mjs'

export const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** @param {number} x @param {number} n */
export const rotr = (x, n) => (x >>> n) | (x << (32 - n))

/** The 32-bit word at `i` of `a`, 0 past its end. @param {number[]} a @param {number} i */
export const word = (a, i) => a[i] ?? 0

/** The 64-word message schedule of the 64-byte block at `at`. @param {number[]} bytes @param {number} at @returns {number[]} */
export function sha256Schedule(bytes, at) {
  /** @type {number[]} */
  const w = []
  for (let i = 0; i < 16; i++) w[i] = (word(bytes, at + 4 * i) << 24) | (word(bytes, at + 4 * i + 1) << 16) | (word(bytes, at + 4 * i + 2) << 8) | word(bytes, at + 4 * i + 3)
  for (let i = 16; i < 64; i++) {
    const [a, b] = [word(w, i - 15), word(w, i - 2)]
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
    const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
    w[i] = (word(w, i - 16) + s0 + word(w, i - 7) + s1) | 0
  }
  return w
}

/** One 64-byte block folded into the state `h`. @param {number[]} h @param {number[]} bytes @param {number} at */
export function sha256Block(h, bytes, at) {
  const w = sha256Schedule(bytes, at)
  let [a, b, c, d, e, f, g, k] = /** @type {[number, number, number, number, number, number, number, number]} */ (h.slice())
  for (let i = 0; i < 64; i++) {
    const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + word(SHA256_K, i) + word(w, i)) | 0
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
    k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
  }
  ;[a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (word(h, i) + v) | 0 })
}

/** The sha256 of a string's UTF-8 bytes, as 64 lower-case hex chars. @param {string} s @returns {string} */
export function sha256Hex(s) {
  const bytes = utf8Bytes(s)
  const bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  // The length as a 64-bit big-endian integer; a string past 2^32 bits never reaches here.
  bytes.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  for (let at = 0; at < bytes.length; at += 64) sha256Block(h, bytes, at)
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * The memory skill's id of a record of `kind` with `title` and `scope`.
 * @param {string} kind @param {string} title @param {string} scope @returns {string}
 */
export function memoryRecordId(kind, title, scope) {
  const t = title.trim().replace(/\s+/g, ' ').toLowerCase()
  const s = scope.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return `${kind}-${sha256Hex(`${kind}\n${t}\n${s}`).slice(0, 10)}`
}
