// The engines' complexity for the quality delta (realm @nick/craft, #147). workflows/*.js are outside
// lint's scope — a sandbox body (top-level `return`, `await`) does not parse as a module — so each is
// wrapped as the engine checks wrap it (the checkout's own `wrapWorkflow`, lib/check-workflow-types.mjs:
// the body inside an async function, every craft-inline region blanked and imported instead, so inlined
// lib code is counted once, in lib/) and linted with only the measuring rules on. Reports come back at
// their line of workflows/<file>.js; the wrapper function itself is the engine's top level.
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
 * Lint results for every workflows/*.js, wrapped, under `override` alone (no config file).
 * @param {string} dir @param {EslintCtor} ESLint @param {Record<string, unknown>} override @param {Deps} deps
 * @returns {Promise<Result<LintResult[]>>}
 */
export async function engineResults(dir, ESLint, override, deps) {
  const wfDir = path.join(dir, 'workflows')
  const files = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter(f => f.endsWith('.js')).sort() : []
  if (!files.length) return notMeasured('no workflows/*.js in the checkout')
  let wrap
  try { wrap = await deps.loadWrapper(dir) } catch (e) { return failed(`the engine wrapper failed to load: ${errText(e)}`) }
  if (!wrap) return notMeasured('the checkout has no engine wrapper (wrapWorkflow in lib/check-workflow-types.mjs)')
  const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: [override] })
  /** @type {LintResult[]} */
  const out = []
  for (const f of files) {
    try {
      const src = fs.readFileSync(path.join(wfDir, f), 'utf8')
      const { text, offset } = wrap(src, dir)
      // A .mjs name, so ESLint parses the wrapped text as the module it is.
      const [res] = await eslint.lintText(text, { filePath: path.join(wfDir, f.replace(/\.js$/, '.mjs')) })
      const broken = res ? res.messages.find(m => m.ruleId == null) : { message: 'no lint result' }
      if (!res || broken) return failed(`workflows/${f}: ${broken?.message ?? 'no lint result'}`)
      const lines = src.split('\n').length
      const wfLine = text.split('\n').findIndex(l => l.startsWith('async function __wf(')) + 1
      out.push({ filePath: path.join(wfDir, f), messages: res.messages.flatMap(m => engineMessage(m, offset, lines, wfLine) ?? []) })
    } catch (e) {
      return failed(`workflows/${f}: ${errText(e)}`)
    }
  }
  return ok(out)
}
