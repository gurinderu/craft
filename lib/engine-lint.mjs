// typescript-eslint's unsafe family over the engines' own code, at zero tolerance: the `any` the
// ceiling counts is where it enters; these rules refuse it where it is used — assigned, called,
// returned, passed, or read through (realm @nick/craft, #137). Run through ESLint's Node API (the
// synchronous Linter) on the very ts.Program the engine type check compiled (`parserOptions.programs`),
// so the rules see the types tsc saw, wrapper and craft-inline imports included. ESLint and
// typescript-eslint come from the repo root's own node_modules only, as TypeScript does (run-tsc.mjs):
// a checkout nested in another never borrows the outer one's. Fail closed: either package absent there,
// or a program that does not hold an engine, is a problem, never a skip.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** The rules, each at error: one report fails the check. */
export const UNSAFE_RULES = [
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-return',
]

/**
 * @typedef {{ ruleId: string | null, message: string, line: number, column: number, fatal?: boolean }} LintMessage
 * @typedef {{ verify(text: string, config: unknown, options: { filename: string }): LintMessage[] }} SyncLinter
 * @typedef {{ linter: SyncLinter, config: (program: unknown) => unknown[] }} EngineLinter
 */

/**
 * ESLint and typescript-eslint as installed at `root` (its devDependencies); a string says what is missing.
 * @param {string} root @returns {EngineLinter | string}
 */
export function loadEngineLinter(root) {
  // Module resolution walks parent directories; only the root's own install may answer it.
  const absent = ['eslint', 'typescript-eslint'].map(n => path.join('node_modules', n))
    .filter(rel => !fs.existsSync(path.join(root, rel, 'package.json')))
  if (absent.length) return `ESLint or typescript-eslint is not installed at the repo root (${absent.join(', ')} absent) — run npm ci; the engines' unsafe-any rules did not run`
  const req = createRequire(path.join(root, 'package.json'))
  /** @type {{ Linter: new (o: { configType: 'flat', cwd: string }) => SyncLinter }} */
  let eslint
  /** @type {{ parser: unknown, plugin: unknown }} */
  let tseslint
  try {
    eslint = /** @type {typeof eslint} */ (req('eslint'))
    tseslint = /** @type {typeof tseslint} */ (req('typescript-eslint'))
  } catch (e) {
    return `ESLint or typescript-eslint is not installed at the repo root (${/** @type {Error} */ (e).message.split('\n')[0]}) — run npm ci; the engines' unsafe-any rules did not run`
  }
  const linter = new eslint.Linter({ configType: 'flat', cwd: root })
  const rules = Object.fromEntries(UNSAFE_RULES.map(r => [r, 'error']))
  return {
    linter,
    config: program => [{
      files: ['**/*.mjs'],
      // An engine may not switch a rule off any more than it may switch tsc off.
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
      languageOptions: { parser: tseslint.parser, parserOptions: { programs: [program] } },
      plugins: { '@typescript-eslint': tseslint.plugin },
      rules,
    }],
  }
}

/**
 * Lints each wrapped engine in `program` and reports at its line of workflows/<file>.js.
 * @param {EngineLinter} engineLinter
 * @param {{ getSourceFile(f: string): { text: string } | undefined }} program
 * @param {Map<string, { file: string, offset: number, lines: number }>} wrapped  wrapped path → its engine
 * @returns {string[]}
 */
export function unsafeAnyProblems(engineLinter, program, wrapped) {
  /** @type {string[]} */
  const problems = []
  const config = engineLinter.config(program)
  for (const [out, at] of wrapped) {
    const sf = program.getSourceFile(out)
    if (!sf) { problems.push(`${at.file}: not in the compiled program, so the unsafe-any rules did not read it`); continue }
    /** @type {LintMessage[]} */
    let messages
    try { messages = engineLinter.linter.verify(sf.text, config, { filename: out }) }
    catch (e) { problems.push(`${at.file}: ESLint threw: ${/** @type {Error} */ (e).message.split('\n')[0]} — the unsafe-any rules did not run`); continue }
    for (const m of messages) {
      const n = m.line - at.offset
      const where = n >= 1 && n <= at.lines ? `${at.file}:${n}:${m.column}` : `${at.file} (lines the checker adds: a craft-inline import or the sandbox wrapper)`
      problems.push(`${where} ${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`)
    }
  }
  return problems
}
