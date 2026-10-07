// The engines' complexity for the quality delta (realm @nick/craft, #147). The engines (src/*.js) are outside
// lint's scope — a sandbox body (top-level `return`, `await`) does not parse as a module — so each is
// wrapped as the engine checks wrap it (the checkout's own `wrapWorkflow`, lib/check-workflow-types.mjs:
// the body inside an async function, every craft-inline region blanked and imported instead, so inlined
// lib code is counted once, in lib/) and linted with only the measuring rules on. Reports come back at
// their line of src/<file>.js; the wrapper function itself is the engine's top level.
import fs from 'node:fs'
import path from 'node:path'
import { errText, failed, notMeasured, ok } from './quality-result.mjs'

/** @typedef {import('./quality-result.mjs').LintResult} LintResult */
/** @typedef {import('./quality-result.mjs').LintMessage} LintMessage */
/** @typedef {import('./quality-result.mjs').EslintCtor} EslintCtor */
/** @typedef {import('./quality-result.mjs').Deps} Deps */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */

/** The name an engine's top-level code gets in place of the wrapper function's. */
export const TOP_LEVEL = 'engine top level'

/**
 * A wrapped engine's message at its line of the engine. On the wrapper's own lines only the wrapper
 * function (at `wfLine`) counts — it is the engine's top level, reported at line 1; the rest there (the
 * `void (() => meta)` closure the wrapper adds) is not the engine's code: null.
 * @param {LintMessage} m @param {number} offset @param {number} lines @param {number} wfLine
 * @returns {LintMessage | null}
 */
export function engineMessage(m, offset, lines, wfLine) {
  const n = m.line - offset
  if (n >= 1 && n <= lines) return { ...m, line: n }
  if (m.line !== wfLine) return null
  return { ...m, line: 1, message: m.message.replace(/^Async function '__wf'/, TOP_LEVEL) }
}

/**
 * One engine linted wrapped, its messages at their engine lines; a string says why it could not be.
 * @param {{ lintText: (text: string, o: { filePath: string }) => Promise<LintResult[]> }} eslint
 * @param {import('./quality-result.mjs').Wrapper} wrap @param {string} dir @param {string} file an engine's path (src/*.js, or workflows/*.js before the engines moved)
 * @returns {Promise<LintResult | string>}
 */
async function lintEngine(eslint, wrap, dir, file) {
  const src = fs.readFileSync(file, 'utf8')
  const { text, offset } = wrap(src, dir)
  // A .mjs name, so ESLint parses the wrapped text as the module it is.
  const [res] = await eslint.lintText(text, { filePath: file.replace(/\.js$/, '.mjs') })
  if (!res) return 'no lint result'
  // A parse error is fatal; the notice that an inline directive was ignored (noInlineConfig) is not.
  const broken = res.messages.find(m => m.fatal)
  if (broken) return broken.message
  const lines = src.split('\n').length
  const wfLine = text.split('\n').findIndex(l => l.startsWith('async function __wf(')) + 1
  return { filePath: file, messages: res.messages.flatMap(m => engineMessage(m, offset, lines, wfLine) ?? []) }
}

/** @param {string} d @returns {string[]} its `.js` files, none when it is absent */
const jsIn = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.js')).sort() : [])

/**
 * Lint results for every engine as authored, wrapped, under `override` alone (no config file): src/*.js, or
 * workflows/*.js in a checkout whose src/ holds none (from before the engines moved there) — the generated workflows/ carries the
 * inlined code without its fences, which the wrapper would count as the engine's own.
 * @param {string} dir @param {EslintCtor} ESLint @param {Record<string, unknown>} override @param {Deps} deps
 * @returns {Promise<Result<LintResult[]>>}
 */
export async function engineResults(dir, ESLint, override, deps) {
  const engineDir = jsIn(path.join(dir, 'src')).length ? 'src' : 'workflows'
  const wfDir = path.join(dir, engineDir)
  const files = jsIn(wfDir)
  // No engines is a measured nothing, not a gap: the total is whole without them.
  if (!files.length) return ok([])
  let wrap
  try { wrap = await deps.loadWrapper(dir) } catch (e) { return failed(`the engine wrapper failed to load: ${errText(e)}`) }
  if (!wrap) return notMeasured('the checkout has no engine wrapper (wrapWorkflow in lib/check-workflow-types.mjs)')
  // No inline config, as lib/engine-lint.mjs and eslint.config.mjs hold it: an `eslint-disable` in an engine
  // must not hide complexity the gate still counts.
  const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: [{ ...override, linterOptions: { noInlineConfig: true } }] })
  /** @type {LintResult[]} */
  const out = []
  for (const f of files) {
    const r = await lintEngine(eslint, wrap, dir, path.join(wfDir, f)).catch(e => errText(e))
    if (typeof r === 'string') return failed(`${engineDir}/${f}: ${r}`)
    out.push(r)
  }
  return ok(out)
}
