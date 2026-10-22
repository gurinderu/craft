// Whether a diff changes PRODUCTION code of a language profile, judged by path alone: the review
// engine forces its `tests` lens on whenever it does, so the coverage adversary runs exactly where a
// missing or hollow test matters most, on a code change that touched no test. The scout keeps the
// test-only case (it picks `tests` on changed tests). Pasted into src/review.js by the craft-inline gate.
import { pathSegments } from './path-segments.mjs'

// A path is test code when a directory segment names a test tree (case-insensitive, at any depth) or
// its basename follows a test-file convention: `foo_test.rs`, `foo.test.ts`, `foo-spec.js`,
// `tests.rs`, `test_foo.py`.
/** @param {unknown} f @returns {boolean} */
export function isTestPath(f) {
  const segs = pathSegments(f)
  const base = segs.pop() ?? ''
  if (segs.some(s => /^(tests?|__tests__|testdata|fixtures|__fixtures__|__snapshots__|specs?)$/i.test(s))) return true
  return /(^|[._-])(tests?|spec)\.[^.]+$/i.test(base) || /^test_/i.test(base)
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
