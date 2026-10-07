// Every workflow script must stay under the size the Claude Code harness registers. Over it, the harness drops
// the script from the Workflow tool's list without a word: `craft:review` vanished from a consumer's list on
// craft 0.23.0 (review.js at 573336 bytes), and `craft:rust-review` failed on its nested call to it. The check
// fails at CEILING, below the harness limit, so a growing engine turns this red before a consumer sees it gone.
// It attests form only: whether the harness registers a script is observed in a consumer (REALITY.md).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outputLines, runIfMain } from './script-main.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The harness does not register a workflow script larger than this (512 KiB): the Workflow tool's `script`
 * schema carries `maxLength: 524288` — characters — on Claude Code 2.1.286 (realm @nick/craft, node #198).
 * This check counts bytes, the stricter measure: a script is never longer in characters than in UTF-8 bytes.
 */
export const HARNESS_LIMIT = 524288
/**
 * The gate's ceiling (500 KiB): 12 KiB of headroom under the harness limit; the engines carry inlined code
 * without its whole-line comments to stay under it (realm @nick/craft, node #199). What relieves review.js
 * next as it nears the ceiling is open (realm @nick/craft, node #200).
 */
export const CEILING = 512000

/**
 * One problem line per script over the ceiling.
 * @param {{ name: string, bytes: number }[]} scripts @param {number} [ceiling] @returns {string[]}
 */
export function sizeProblems(scripts, ceiling = CEILING) {
  return scripts
    .filter(s => s.bytes > ceiling)
    .map(s => `workflows/${s.name} is ${s.bytes} bytes, over the ${ceiling}-byte ceiling (the harness does not register a workflow script over ${HARNESS_LIMIT} bytes)`)
}

/**
 * @param {string[]} _argv  unused: it takes no flags @param {NodeJS.ProcessEnv} _env  unused
 * @param {string} [root]  the checkout to check
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, _env, root = ROOT) {
  const o = outputLines()
  const dir = path.join(root, 'workflows')
  const scripts = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
    .map(name => ({ name, bytes: fs.statSync(path.join(dir, name)).size }))
  if (!scripts.length) {
    o.stderr.push('FAIL  workflows/ :: no .js scripts found — nothing was checked')
    return { exitCode: 1, ...o }
  }
  const problems = sizeProblems(scripts)
  for (const s of scripts) if (s.bytes <= CEILING) o.stdout.push(`ok    workflows/${s.name} ${s.bytes} bytes (${CEILING - s.bytes} under the ceiling)`)
  for (const p of problems) o.stderr.push(`FAIL  ${p}`)
  return { exitCode: problems.length ? 1 : 0, ...o }
}

await runIfMain(import.meta.url, run)
