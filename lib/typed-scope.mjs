// How far the strict type check reaches: lib/tsconfig.json held to maximum strictness, and every lib/ module a
// bundled engine carries (lib/engine-form.mjs, libModulesOf) read by that check with nothing switched off.
import path from 'node:path'
import { directiveProblems } from './ts-directives.mjs'

/** @typedef {import('./run-tsc.mjs').TypeScript} TypeScript */

// The strictness flags lib/tsconfig.json must keep on, beyond `strict` itself.
export const STRICT_FLAGS = /** @type {const} */ (['noUncheckedIndexedAccess', 'exactOptionalPropertyTypes',
  'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noImplicitOverride', 'noPropertyAccessFromIndexSignature',
  'noUnusedLocals', 'noUnusedParameters', 'noUncheckedSideEffectImports', 'verbatimModuleSyntax'])

// The `allow*` flags lib/tsconfig.json must keep explicitly false: left unset, tsc only suggests, never errors.
export const STRICT_OFF_FLAGS = /** @type {const} */ (['allowUnreachableCode', 'allowUnusedLabels'])

// The family `strict` turns on — every option tsc declares with `strictFlag` (a test pins this list
// to the installed tsc). An explicit `false` on one overrides `strict`, and --showConfig reports it.
export const STRICT_FAMILY_FLAGS = /** @type {const} */ (['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes',
  'strictBindCallApply', 'strictPropertyInitialization', 'strictBuiltinIteratorReturn', 'noImplicitThis',
  'useUnknownInCatchVariables', 'alwaysStrict'])

// Every way a tsconfig's compilerOptions fall short of the maximum strictness: a flag not on, an
// `allow*` not explicitly false, a strict-family flag switched off. Shared by check-workflows (on
// lib/tsconfig.json as --showConfig resolves it) and the parity test (on both configs as written).
/**
 * @param {string} label  the config named in each problem
 * @param {Record<string, unknown>} opts
 * @returns {string[]}
 */
export function strictnessProblems(label, opts) {
  const problems = []
  for (const flag of ['allowJs', 'checkJs', 'strict', ...STRICT_FLAGS]) {
    if (opts[flag] !== true) problems.push(`${label}: ${flag} is not on`)
  }
  for (const flag of STRICT_OFF_FLAGS) {
    if (opts[flag] !== false) problems.push(`${label}: ${flag} is not false`)
  }
  for (const flag of STRICT_FAMILY_FLAGS) {
    if (opts[flag] === false) problems.push(`${label}: ${flag} is turned off`)
  }
  return problems
}

// The lib/ code a bundled engine carries ships into every consumer's review, so it must be code the strict
// type check actually reads, at full strictness, with nothing switched off. The answer comes from tsc itself — the files it
// lists and the config it resolves — rather than a copy of its include/exclude rules, which drift.
/**
 * @param {{ root: string, sources: string[], typedFiles: string[], config: { compilerOptions?: Record<string, unknown> },
 *   readSource: (source: string) => string, ts: TypeScript }} input  `typedFiles`: `tsc --listFilesOnly`;
 *   `config`: `tsc --showConfig`; `ts`: the pinned compiler, whose parse finds the directives (ts-directives.mjs)
 * @returns {string[]} one line per problem; empty when every bundled source is strictly type-checked
 */
export function typedScopeProblems({ root, sources, typedFiles, config, readSource, ts }) {
  const problems = strictnessProblems('lib/tsconfig.json', config.compilerOptions || {})
  const typed = new Set(typedFiles.map(f => path.resolve(f)))
  for (const s of [...new Set(sources)].sort()) {
    // tsc also reads the tests and the OpenCode run-record they import; neither is code an engine
    // may carry, whatever tsc's list says.
    if (!/^lib\/(?:[^/.][^/]*\/)*[^/.][^/]*\.mjs$/.test(s) || /\.test\.mjs$/.test(s) || s.split('/').includes('..')) {
      problems.push(`${s} is bundled into workflows/ but is not a non-test lib module`)
      continue
    }
    if (!typed.has(path.resolve(root, s))) {
      problems.push(`${s} is bundled into workflows/ but not read by the strict type check (tsc -p lib/tsconfig.json)`)
      continue
    }
    // The directives tsc honours, as the engines' own check reads them — not a regex, which missed
    // `// @ts-ignorefoo` (tsc honours it) and refused a mere mention in a string or in prose.
    const sf = ts.createSourceFile(s, readSource(s), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    problems.push(...directiveProblems(sf, s).map(p => `${p} (bundled into workflows/)`))
  }
  return problems
}
