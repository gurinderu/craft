// typescript-eslint's unsafe family over the engines' own code, at zero tolerance: the `any` the
// ceiling counts is where it enters; these rules refuse it where it is used — assigned, called,
// returned, passed, or read through (realm @nick/craft, #137). Run through ESLint's Node API (the
// synchronous Linter) on the very ts.Program the engine type check compiled (`parserOptions.programs`),
// so the rules see the types tsc saw, wrapper and craft-inline imports included. ESLint and
// typescript-eslint come from the repo root's own node_modules only, as TypeScript does (run-tsc.mjs):
// a checkout nested in another never borrows the outer one's. Fail closed: either package absent there,
// or a program that does not hold an engine, is a problem, never a skip. The same program is held to the
// complexity bars lint holds lib/ to (lib/complexity-rules.mjs, realm #155; eslint-plugin-sonarjs from the root too);
// an engine's top-level body, wrapped as the sandbox runs it, is one function there.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { COMPLEXITY_RULES } from './complexity-rules.mjs'

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
  const absent = ['eslint', 'typescript-eslint', 'eslint-plugin-sonarjs'].map(n => path.join('node_modules', n))
    .filter(rel => !fs.existsSync(path.join(root, rel, 'package.json')))
  if (absent.length) return `ESLint, typescript-eslint or eslint-plugin-sonarjs is not installed at the repo root (${absent.join(', ')} absent) — run npm ci; the engines' unsafe-any and complexity rules did not run`
  const req = createRequire(path.join(root, 'package.json'))
  /** @type {{ Linter: new (o: { configType: 'flat', cwd: string }) => SyncLinter }} */
  let eslint
  /** @type {{ parser: unknown, plugin: unknown }} */
  let tseslint
  /** @type {unknown} */
  let sonarjs
  try {
    eslint = /** @type {typeof eslint} */ (req('eslint'))
    tseslint = /** @type {typeof tseslint} */ (req('typescript-eslint'))
    sonarjs = req('eslint-plugin-sonarjs')
  } catch (e) {
    return `ESLint, typescript-eslint or eslint-plugin-sonarjs is not installed at the repo root (${/** @type {Error} */ (e).message.split('\n')[0]}) — run npm ci; the engines' unsafe-any and complexity rules did not run`
  }
  const linter = new eslint.Linter({ configType: 'flat', cwd: root })
  const rules = { ...Object.fromEntries(UNSAFE_RULES.map(r => [r, 'error'])), ...COMPLEXITY_RULES }
  return {
    linter,
    config: program => [{
      files: ['**/*.mjs'],
      // An engine may not switch a rule off any more than it may switch tsc off.
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
      languageOptions: { parser: tseslint.parser, parserOptions: { programs: [program] } },
      plugins: { '@typescript-eslint': tseslint.plugin, sonarjs },
      rules,
    }],
  }
}

/**
 * Where a message lands in workflows/<file>.js: its own line, or the part of the wrapped module it came from.
 * @param {{ file: string, offset: number, lines: number }} at  @param {LintMessage} m  @returns {string}
 */
function located(at, m) {
  const n = m.line - at.offset
  if (n >= 1 && n <= at.lines) return `${at.file}:${n}:${m.column}`
  if (m.ruleId && m.ruleId in COMPLEXITY_RULES) return `${at.file} (its top-level body, run as the sandbox's async function)`
  return `${at.file} (lines the checker adds: a craft-inline import or the sandbox wrapper)`
}

/**
 * The rules' messages for one wrapped engine, or why it could not be linted.
 * @param {EngineLinter} engineLinter  @param {unknown[]} config
 * @param {{ getSourceFile(f: string): { text: string } | undefined }} program
 * @param {string} out  @param {{ file: string, offset: number, lines: number }} at  @returns {string[]}
 */
function engineProblems(engineLinter, config, program, out, at) {
  const sf = program.getSourceFile(out)
  if (!sf) return [`${at.file}: not in the compiled program, so the unsafe-any and complexity rules did not read it`]
  /** @type {LintMessage[]} */
  let messages
  try { messages = engineLinter.linter.verify(sf.text, config, { filename: out }) }
  catch (e) { return [`${at.file}: ESLint threw: ${/** @type {Error} */ (e).message.split('\n')[0]} — the unsafe-any and complexity rules did not run`] }
  return messages.map(m => `${located(at, m)} ${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`)
}

/**
 * Lints each wrapped engine in `program` and reports at its line of workflows/<file>.js.
 * @param {EngineLinter} engineLinter
 * @param {{ getSourceFile(f: string): { text: string } | undefined }} program
 * @param {Map<string, { file: string, offset: number, lines: number }>} wrapped  wrapped path → its engine
 * @returns {string[]}
 */
export function unsafeAnyProblems(engineLinter, program, wrapped) {
  const config = engineLinter.config(program)
  return [...wrapped].flatMap(([out, at]) => engineProblems(engineLinter, config, program, out, at))
}
