// The Claude Code plugin manifest validated as it installs. The delivery at integrations/claude-code reaches the
// shared skills/, lib/, content/, src/ and README.md through symlinks, and the validator reads nothing inside a symlinked
// directory (it warns, and --strict fails on the warning) — while an install copies the delivery with each link
// dereferenced into a real directory (realm @nick/craft, #460). So the delivery is materialized the same way
// (lib/materialize-claude-code.mjs, which also builds the release's symlink-free branch) into
// a temporary directory, and that copy is what `claude plugin validate <copy>/.claude-plugin/plugin.json --strict`
// reads (the plugin manifest path also reads hooks/hooks.json). The marketplace manifest stays the gate's own
// `plugin validate . --strict` row.
//
// Run: node lib/validate-plugin.mjs   (the validator through `npx --yes @anthropic-ai/claude-code`)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DELIVERY, materialize } from './materialize-claude-code.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @typedef {(cmd: string, args: string[]) => number | null} Exec */

/** @type {Exec} */
function spawnValidator(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit' }).status
}

/**
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} _env  unused: the validator inherits the process environment
 * @param {{ root?: string, exec?: Exec }} [deps]  injected by tests
 * @returns {import('./script-main.mjs').ScriptResult}
 */
export function run(_argv, _env, { root = ROOT, exec = spawnValidator } = {}) {
  const o = outputLines()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-plugin-'))
  try {
    const manifest = path.join(materialize(root, tmp), '.claude-plugin', 'plugin.json')
    o.stdout.push(`validate-plugin: ${DELIVERY} materialized at ${path.dirname(path.dirname(manifest))}`)
    const status = exec('npx', ['--yes', '@anthropic-ai/claude-code', 'plugin', 'validate', manifest, '--strict'])
    if (status !== 0) o.stderr.push(`validate-plugin: the validator failed on the materialized ${DELIVERY} (exit ${status ?? 'signal'})`)
    return { exitCode: status === 0 ? 0 : 1, ...o }
  } catch (e) {
    o.stderr.push(`validate-plugin: ${e instanceof Error ? e.message : String(e)}`)
    return { exitCode: 1, ...o }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

await runIfMain(import.meta.url, run)
