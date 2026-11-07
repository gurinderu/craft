// The crate scope rust-audit dispatches each nested `review` with (src/rust-audit.js): a crate directory from
// the scout made a repo-relative pathspec, or null. Lifted out of the engine so the tests import it.
import { pathSegments } from './path-segments.mjs'

// A crate directory must reach the nested `review` as a REPO-RELATIVE pathspec. Asking the scout for
// one is not enough: `cargo metadata` prints `manifest_path` absolute, so a scout that copies it out
// hands back absolute crate directories — and `review` now REFUSES an absolute `path` (it cannot
// tell a repository from a scope) instead of running a whole-repo review under a crate's label. The
// refusal is right and it is also the whole per-crate measurement, so the repair belongs in rust-audit, at
// the boundary the bad value crosses. Segments, not a string prefix: `/r/` + `/r/./crates/core` is the
// same request as `crates/core`. No disk and no Node API, so a symlinked or differently-cased
// spelling stays unrepairable — such a crate is reported NOT RUN rather than reviewed unscoped.
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/
// The repo-relative crate directory, or null when it cannot be derived.
/** @param {unknown} p @param {string} repoRoot  the scout's repository root, '' when unresolved @returns {string | null} */
export function crateScope(p, repoRoot) {
  const raw = String(p ?? '').trim()
  if (!raw) return null
  if (!ABSOLUTE_PATH.test(raw)) {
    // A relative path must stay INSIDE the repository, and `pathSegments` keeps a leading `..` as a
    // literal segment when there is nothing left to pop — so `../../elsewhere` normalized to itself
    // and was handed to the nested `review` as a pathspec climbing out of the repo under audit. The
    // absolute branch below already refuses exactly this (a path that does not resolve inside the
    // root); the relative branch let it through the door next to it. Same answer: null, which the
    // caller reports as NOT RUN rather than reviewing something else under this crate's label.
    const segs = pathSegments(raw)
    if (segs[0] === '..') return null
    return segs.join('/') || '.'
  }
  return absoluteScope(raw, repoRoot)
}
// An absolute crate path made relative to the repo root, or null when it does not resolve inside it.
/** @param {string} raw @param {string} repoRoot @returns {string | null} */
function absoluteScope(raw, repoRoot) {
  const r = pathSegments(repoRoot)
  const abs = pathSegments(raw)
  if (!repoRoot || !r.length || abs.length < r.length) return null
  for (let i = 0; i < r.length; i++) if (abs[i] !== r[i]) return null
  return abs.slice(r.length).join('/') || '.'
}
