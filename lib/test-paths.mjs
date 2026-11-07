// Whether a diff changes PRODUCTION code of a language profile, judged by path alone: the review
// engine forces its `tests` lens on whenever it does, so the coverage adversary runs exactly where a
// missing or hollow test matters most, on a code change that touched no test. The scout keeps the
// test-only case (it picks `tests` on changed tests). Imported by src/review.js.
import { NON_CONTRACT_DIRS } from './contract-paths.mjs'
import { pathSegments } from './path-segments.mjs'

// A path is test code when a directory segment is one of the test trees contract-paths already names
// (one definition of a test folder, case-insensitive, at any depth) or its basename follows a test-file
// convention: `foo_test.rs`, `foo.test.ts`, `tests.rs`, `test_foo.py`. NOT `spec`: in Rust a `spec.rs`
// or `pod_spec.rs` is production code (a CRD spec), and calling it a test would drop the lens there.
/** @param {unknown} f @returns {boolean} */
export function isTestPath(f) {
  const segs = pathSegments(f)
  const base = segs.pop() ?? ''
  if (segs.some(s => NON_CONTRACT_DIRS.has(s.toLowerCase()))) return true
  return /(^|[._-])tests?\.[^.]+$/i.test(base) || /^test_/i.test(base)
}

// Whether any changed file is a source file of the profile (one of its diff globs, as the engine
// passes them to git: `'*.rs'`, `'flake.lock'`) and not test code.
/** @param {unknown[]} files @param {string[]} diffGlobs @returns {boolean} */
export function changesProductionCode(files, diffGlobs) {
  const globs = diffGlobs.map(g => g.replace(/^'|'$/g, ''))
  return files.some(f => {
    const base = pathSegments(f).pop() ?? ''
    return !isTestPath(f) && globs.some(g => (g.startsWith('*') ? base.endsWith(g.slice(1)) : base === g))
  })
}
