// The craft CLI binary for this plugin version, fetched from the GitHub release that version was cut as: the
// release workflow (.github/workflows/release-please.yml, job cli-binaries) attaches craft-<target>.tar.gz — the
// binary `craft` (`craft.exe` for Windows) at the archive root — and its .sha256 to each release. The cli-review engine runs this before its
// first step when no craftBin is given (lib/cli-review-steps.mjs).
//
// Run: node lib/craft-bin.mjs ensure [--version <v>] [--repo <owner/name>]
// Prints the binary's absolute path (~/.craft/bin/<version>/craft, craft.exe on Windows), exit 0: the copy already
// there when it is an executable file, else the release asset downloaded (redirects followed), its SHA-256 checked,
// unpacked with `tar` (an argument array, no shell; on Windows the tar.exe Windows 10 and later ship in System32,
// which reads .tar.gz — not whichever tar a Git Bash PATH puts first, whose GNU tar takes `C:` for a remote host)
// and moved into place by a rename. On any failure one line on stderr, exit 1.
// The version defaults to the plugin manifest's (pluginVersion); the repository to gurinderu/craft.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { download } from './http-download.mjs'
import { runIfMain } from './script-main.mjs'

const DEFAULT_REPO = 'gurinderu/craft'
const USAGE = 'usage: craft-bin ensure [--version <v>] [--repo <owner/name>]'

/** The release target of each platform the workflow builds for, by `${process.platform}-${process.arch}`; linux is static musl. */
const TARGETS = /** @type {Record<string, string>} */ ({
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
})

/** The binary's file name in the archive and in the cache. @param {string} platform */
export const binaryName = platform => (platform === 'win32' ? 'craft.exe' : 'craft')

/**
 * The tar that unpacks on this host: on Windows the system's own by its full path.
 * @param {string} [platform] @param {NodeJS.ProcessEnv} [env] @returns {string}
 */
export function tarCommand(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar'
  return path.win32.join(env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows', 'System32', 'tar.exe')
}

/** @param {string} platform @param {string} arch @returns {string} */
export function targetOf(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) throw new Error(`no released craft binary for ${platform}/${arch} (only linux and darwin on x64 and arm64, and windows on x64); build it from cli/ and pass craftBin`)
  return target
}

/**
 * The version and repository `ensure` was asked for.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {{ version: string, repo: string }}
 */
export function parseArgs(argv, env = process.env) {
  const [cmd, ...rest] = argv
  if (cmd !== 'ensure') throw new Error(USAGE)
  const opts = flags(rest)
  opts.version ||= pluginVersion(env)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.version)) throw new Error(`not a version: ${JSON.stringify(opts.version)}`)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo) || opts.repo.includes('..')) throw new Error(`not an owner/name repository: ${JSON.stringify(opts.repo)}`)
  return opts
}

/** The `--version` and `--repo` flags, each followed by its value. @param {string[]} rest */
function flags(rest) {
  const opts = { version: '', repo: DEFAULT_REPO }
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]]
    if ((flag !== '--version' && flag !== '--repo') || value == null) throw new Error(USAGE)
    opts[flag === '--version' ? 'version' : 'repo'] = value
  }
  return opts
}

/**
 * The plugin manifests that may hold this plugin's version, first readable wins. The copy this script sits in comes
 * first: the directory above lib/ (an installed copy, lib/ a real directory), then the Claude Code delivery of the
 * checkout lib/ resolves into — a load in place (`--plugin-dir`, a local marketplace) reaches lib/ through
 * integrations/claude-code/lib, a symlink to the repository's own lib/, beside which there is no manifest. The
 * plugin root the harness names (CLAUDE_PLUGIN_ROOT) is the last resort: inside a session with another craft
 * installed it names that copy, not the one being run.
 * @param {NodeJS.ProcessEnv} env @returns {string[]}
 */
export function manifestCandidates(env) {
  const above = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const roots = [above, path.join(above, 'integrations', 'claude-code'), env['CLAUDE_PLUGIN_ROOT'] || '']
  return roots.filter(Boolean).map(root => path.join(root, '.claude-plugin', 'plugin.json'))
}

/** The version in the first readable plugin manifest, '' when none is. @param {NodeJS.ProcessEnv} env @returns {string} */
function pluginVersion(env) {
  for (const file of manifestCandidates(env)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof manifest?.version === 'string') return manifest.version
    } catch { /* the next candidate */ }
  }
  return ''
}

/** Whether `file` is an executable regular file. @param {string} file */
function isExecutable(file) {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true) } catch { return false }
}

/**
 * The binary's path, fetched and installed first unless an executable copy is already there.
 * @param {{ version: string, repo: string, home?: string, baseUrl?: string, platform?: string, arch?: string }} o
 * @returns {Promise<string>}
 */
export async function ensure({ version, repo, home = os.homedir(), baseUrl, platform = process.platform, arch = process.arch }) {
  const dir = path.join(home, '.craft', 'bin', version)
  const name = binaryName(platform)
  const bin = path.join(dir, name)
  if (isExecutable(bin)) return bin
  const asset = `craft-${targetOf(platform, arch)}.tar.gz`
  const archive = await fetchVerified(baseUrl ?? `https://github.com/${repo}/releases/download/v${version}`, asset)
  install(archive, asset, name, bin)
  return bin
}

/** The release asset, once its SHA-256 matches the published one. @param {string} base @param {string} asset */
async function fetchVerified(base, asset) {
  const [archive, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/${asset}.sha256`)])
  const expected = /^[0-9a-f]{64}\b/i.exec(sums.toString('utf8').trim())?.[0].toLowerCase()
  if (!expected) throw new Error(`${asset}.sha256 holds no SHA-256`)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) throw new Error(`${asset}: SHA-256 ${actual} is not the published ${expected}`)
  return archive
}

/**
 * `name` unpacked from `archive` beside `bin`, made executable and renamed into place: no half-written binary
 * is ever at `bin`. @param {Buffer} archive @param {string} asset @param {string} name @param {string} bin
 */
function install(archive, asset, name, bin) {
  const dir = path.dirname(bin)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(dir, '.fetch-'))
  try {
    const file = path.join(tmp, asset)
    fs.writeFileSync(file, archive)
    try { execFileSync(tarCommand(), ['-xzf', file, '-C', tmp, name], { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (e) {
      const said = String(/** @type {{ stderr?: unknown }} */ (e).stderr ?? '').trim().split('\n')[0]
      throw new Error(`could not unpack ${name} from ${asset}${said ? `: ${said}` : ''}`)
    }
    const unpacked = path.join(tmp, name)
    if (!fs.lstatSync(unpacked).isFile()) throw new Error(`${name} in ${asset} is not a regular file`)
    fs.chmodSync(unpacked, 0o755)
    fs.renameSync(unpacked, bin)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} [env]
 * @param {{ home?: string, baseUrl?: string, platform?: string, arch?: string }} [deps]  injected by tests
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, env = process.env, deps = {}) {
  try {
    return { exitCode: 0, stdout: [await ensure({ ...parseArgs(argv, env), ...deps })], stderr: [] }
  } catch (e) {
    return { exitCode: 1, stdout: [], stderr: [`craft-bin: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')}`] }
  }
}

await runIfMain(import.meta.url, run)
