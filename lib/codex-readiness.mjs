// What a Codex session must know before it runs craft's review (realm @nick/craft, node #293; the Codex surface,
// #292): whether Codex's own sandbox can run a command at all — the review's agents are `codex exec -s read-only`
// processes, so a sandbox that cannot start fails every one of them — and whether this plugin version's binary is
// already in the cache bin/craft runs (~/.craft/bin/<version>/craft, lib/craft-bin.mjs), since fetching it needs the
// network and writes outside the workspace. Read by the SessionStart hook under Codex only; any failure is silence.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binaryName } from './craft-bin.mjs'

// How long `codex sandbox true` may take before the check gives up and says nothing.
export const SANDBOX_TIMEOUT_MS = 3000

/** @typedef {{ status: number | null, stderr: string, error?: Error }} ProbeResult */
/** @typedef {(command: string, args: string[], timeoutMs: number) => ProbeResult} Runner */

/** The probe as a child process: an argument array, no shell. @type {Runner} */
export const spawnRunner = (command, args, timeoutMs) => {
  const r = spawnSync(command, args, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
  return { status: r.status, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) }
}

/**
 * The line to tell the user when Codex's sandbox cannot run `true`; '' when it can, when `codex` could not be
 * started, or when the probe timed out (nothing is known then).
 * @param {Runner} runner @returns {string}
 */
export function sandboxLine(runner) {
  const r = runner('codex', ['sandbox', 'true'], SANDBOX_TIMEOUT_MS)
  if (r.error || r.status === null || r.status === 0) return ''
  // Codex may print its own WARNING lines before the sandbox's error: the first other line is the error.
  const lines = (r.stderr || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const said = lines.find(l => !l.startsWith('WARNING:')) ?? lines[0] ?? ''
  return [
    `craft: before any work, tell the user that Codex's sandbox cannot run commands on this machine (\`codex sandbox true\` exited ${String(r.status)}${said ? `: ${said}` : ''}).`,
    "So craft's review and its review agents (`codex exec -s read-only`) will fail here.",
    'The fix is to allow unprivileged user namespaces for bwrap (on Ubuntu: the sysctl kernel.apparmor_restrict_unprivileged_userns, or an AppArmor profile for bwrap), or to run the review from another host.',
  ].join(' ')
}

/**
 * The plugin version Codex installed, from `<root>/.codex-plugin/plugin.json`; '' when unreadable.
 * @param {string} root @returns {string}
 */
export function codexPluginVersion(root) {
  try {
    /** @type {unknown} */
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'))
    if (manifest && typeof manifest === 'object' && 'version' in manifest && typeof manifest.version === 'string') return manifest.version
  } catch {
    /* no manifest: no version */
  }
  return ''
}

/**
 * The line to say when this plugin version's binary is not in the cache yet; '' when it is, when a local build is
 * named (CRAFT_BIN), or when the version or plugin root is unknown.
 * @param {{ env: Record<string, string | undefined>, home: string, platform?: string }} o @returns {string}
 */
export function binaryLine({ env, home, platform = process.platform }) {
  const root = env['PLUGIN_ROOT'] || ''
  if (!root || env['CRAFT_BIN']) return ''
  const version = codexPluginVersion(root)
  if (!version) return ''
  const bin = path.join(home, '.craft', 'bin', version, binaryName(platform))
  if (fs.existsSync(bin)) return ''
  return [
    `craft: the craft binary ${version} is not in ~/.craft/bin yet: the first craft review downloads it, which needs the network and writes outside the workspace.`,
    `Run \`sh "${path.join(root, 'bin', 'craft')}" review run --backend codex …\` with escalated permissions and ask the user to approve it.`,
  ].join(' ')
}

/**
 * The context lines for a Codex session start, [] when there is nothing to say. Never throws.
 * @param {{ env: Record<string, string | undefined>, home: string, runner?: Runner, platform?: string }} o
 * @returns {string[]}
 */
export function codexReadiness({ env, home, runner = spawnRunner, platform }) {
  /** @type {string[]} */
  const lines = []
  for (const line of [() => sandboxLine(runner), () => binaryLine({ env, home, ...(platform ? { platform } : {}) })]) {
    try {
      const text = line()
      if (text) lines.push(text)
    } catch {
      /* silence */
    }
  }
  return lines
}
