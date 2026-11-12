// What a Codex session must know before it runs craft's review (realm @nick/craft, node #293; the Codex surface,
// #292): whether Codex's own sandbox can run a command at all — the review's agents are `codex exec -s read-only`
// processes, so a sandbox that cannot start fails every one of them — and whether this plugin version's binary is
// already in the cache bin/craft runs (~/.craft/bin/<version>/craft, lib/craft-bin.mjs), since fetching it needs the
// network and writes outside the workspace. Read by the SessionStart hook under Codex only; any failure is silence.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binaryName, isExecutable } from './craft-bin.mjs'

// How long `codex sandbox true` may take before the check gives up and says nothing.
export const SANDBOX_TIMEOUT_MS = 3000
// What a sandbox that could not be set up prints: bwrap's own error, or the kernel refusing a user namespace. Any
// other failure (a usage error of an older codex-cli spelling, `codex sandbox linux …`; a nested macOS seatbelt) is
// not this machine's sandbox being unable to start, so it is silence.
const SANDBOX_SETUP_FAILURE = /\bbwrap:|operation not permitted|\bunshare\b|user namespace|uid_map/i

/** @typedef {{ status: number | null, stderr: string, error?: Error }} ProbeResult */
/** @typedef {(command: string, args: string[], timeoutMs: number) => ProbeResult} Runner */

/** The probe as a child process: an argument array, no shell. @type {Runner} */
export const spawnRunner = (command, args, timeoutMs) => {
  const r = spawnSync(command, args, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
  return { status: r.status, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) }
}

/**
 * The line to tell the user when Codex's sandbox cannot be set up to run `true`; '' when it can, when `codex` could
 * not be started, when the probe timed out (nothing is known then), or when it failed without a sandbox-setup error.
 * @param {Runner} runner @returns {string}
 */
export function sandboxLine(runner) {
  const r = runner('codex', ['sandbox', 'true'], SANDBOX_TIMEOUT_MS)
  if (r.error || r.status === null || r.status === 0 || !SANDBOX_SETUP_FAILURE.test(r.stderr || '')) return ''
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
  if (isExecutable(bin)) return ''
  return [
    `craft: the craft binary ${version} is not in ~/.craft/bin yet. When you run craft's review (the codex-review skill),`,
    'its first run downloads it, which needs the network and writes outside the workspace:',
    `then run \`sh "${path.join(root, 'bin', 'craft')}" review run --backend codex …\` with escalated permissions and ask the user to approve it.`,
    'This is not a request to start a review now.',
  ].join(' ')
}

/** @typedef {{ name: 'sandbox' | 'binary', text: string }} ReadinessLine */

/**
 * The context lines for a Codex session start, named; [] when there is nothing to say. Never throws.
 * @param {{ env: Record<string, string | undefined>, home: string, runner?: Runner, platform?: string }} o
 * @returns {ReadinessLine[]}
 */
export function codexReadiness({ env, home, runner = spawnRunner, platform }) {
  /** @type {ReadinessLine[]} */
  const lines = []
  /** @type {Array<[ReadinessLine['name'], () => string]>} */
  const checks = [
    ['sandbox', () => sandboxLine(runner)],
    ['binary', () => binaryLine({ env, home, ...(platform ? { platform } : {}) })],
  ]
  for (const [name, line] of checks) {
    try {
      const text = line()
      if (text) lines.push({ name, text })
    } catch {
      /* silence */
    }
  }
  return lines
}

/**
 * The start hook's output with the readiness lines after the role text. They are asked for only under Codex and
 * only when the hook is not switched off (CRAFT_ROLE_HOOK, the `craft-role-hook: off` line: lib/role-hook.mjs's
 * decision, read from the entry). A run that said them is logged as one that spoke, with `readiness` naming them and,
 * when the role text was silent, `reason: 'codex-readiness'` so it stands apart from the role hook's own firings.
 * @param {{ stdout: string, entry: import('./hook-log.mjs').HookEntry }} start
 * @param {() => ReadinessLine[]} readiness
 * @returns {{ stdout: string, entry: import('./hook-log.mjs').HookEntry }}
 */
export function withReadiness({ stdout, entry }, readiness) {
  if (entry.harness !== 'codex' || entry.silent === 'off-env' || entry.silent === 'off-line') return { stdout, entry }
  const lines = readiness()
  if (!lines.length) return { stdout, entry }
  /** @type {unknown} */
  const roleOutput = stdout ? JSON.parse(stdout) : null
  const role = roleOutput ? /** @type {{ hookSpecificOutput: { additionalContext: string } }} */ (roleOutput).hookSpecificOutput.additionalContext : ''
  const text = [role, ...lines.map(l => l.text)].filter(Boolean).join('\n')
  const said = { ...entry, spoke: true, silent: null, readiness: lines.map(l => l.name) }
  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
    entry: entry.spoke ? said : { ...said, reason: 'codex-readiness' },
  }
}
