// The one way this repo's checkers run the TypeScript compiler: the OpenCode plugin's pinned package,
// launched through node with its JS entry (not the .bin shim, which Windows cannot exec without a
// shell). `missing` only when that entry file is absent; any other failure carries tsc's own output.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

/** @param {string} root @returns {string} */
export function tscEntry(root) {
  return path.join(root, 'opencode', 'plugin', 'node_modules', 'typescript', 'bin', 'tsc')
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {{ missing: true, entry: string } | { missing: false, status: number, stdout: string, stderr: string, overflow: boolean }}
 */
export function runTsc(root, args) {
  const entry = tscEntry(root)
  if (!fs.existsSync(entry)) return { missing: true, entry }
  try {
    const stdout = execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    return { missing: false, status: 0, stdout, stderr: '', overflow: false }
  } catch (e) {
    const err = /** @type {{ code?: string, status?: number | null, stdout?: string, stderr?: string, message?: string }} */ (e)
    return {
      missing: false,
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || (err.stdout ? '' : err.message || e)),
      overflow: err.code === 'ENOBUFS',
    }
  }
}

/** @param {string} root @returns {string} */
export function tscMissingMessage(root) {
  return `tsc is not installed at ${path.relative(root, tscEntry(root))} — run npm ci --prefix opencode/plugin`
}

/**
 * The pinned TypeScript module itself, for a checker that parses rather than compiles; null when absent.
 * @param {string} root @returns {typeof import('../opencode/plugin/node_modules/typescript/lib/typescript.js') | null}
 */
export function loadTypescript(root) {
  // The same install marker runTsc checks, so the two never disagree about whether TypeScript is there.
  if (!fs.existsSync(tscEntry(root))) return null
  try { return createRequire(path.join(root, 'package.json'))(path.join(root, 'opencode', 'plugin', 'node_modules', 'typescript')) }
  catch { return null }
}
