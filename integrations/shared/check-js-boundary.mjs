// A tracked JS/TS file has exactly one home: integrations (realm @nick/craft, node #562).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './repo-root.mjs'
import { runIfMain } from './script-main.mjs'

/** @param {string[]} _argv @param {NodeJS.ProcessEnv} _env @param {string} [root] */
export function run(_argv, _env, root = ROOT) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) return { exitCode: 1, stdout: [], stderr: ['cannot enumerate tracked files'] }
  const outside = r.stdout.split('\0').filter(f => /\.(?:[cm]?[jt]sx?)$/.test(f) && !f.startsWith('integrations/') && fs.existsSync(path.join(root, f)))
  return {
    exitCode: outside.length ? 1 : 0,
    stdout: ['checked tracked JavaScript/TypeScript boundary'],
    stderr: outside.map(f => `outside integrations: ${f}`),
  }
}

await runIfMain(import.meta.url, run)
