// A path as normalized SEGMENTS, for containment decided segment by segment rather than on a raw
// string prefix: `/r/./crates/../crates/core` is inside `/r`, and `/r-evil` is not. Both separators
// split, empty and `.` segments vanish, and an interior `..` pops its parent. A `..` with nothing left
// to pop is KEPT as a literal segment, so a path that climbs out stays visibly out — a caller refuses
// it (`segs[0] === '..'`) or it fails to match a root, never reads as inside. No disk and no Node API
// (the engines inline this into the sandbox): symlinks and case-insensitive filesystems are not seen.
/** @param {unknown} p */
export function pathSegments(p) {
  const segs = []
  for (const s of String(p).split(/[\\/]+/)) {
    if (!s || s === '.') continue
    if (s === '..' && segs.length && segs[segs.length - 1] !== '..') { segs.pop(); continue }
    segs.push(s)
  }
  return segs
}
