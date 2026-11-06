// The craft CLI binary for this plugin version, fetched from the GitHub release that version was cut as: the
// release workflow (.github/workflows/release-please.yml, job cli-binaries) attaches craft-<target>.tar.gz — the
// binary `craft` at the archive root — and its .sha256 to each release. The cli-review engine runs this before its
// first step when no craftBin is given (lib/cli-review-steps.mjs).
//
// Run: node lib/craft-bin.mjs ensure [--version <v>] [--repo <owner/name>]
// Prints the binary's absolute path (~/.craft/bin/<version>/craft), exit 0: the copy already there when it is an
// executable file, else the release asset downloaded (redirects followed), its SHA-256 checked, unpacked with
// `tar` (an argument array, no shell) and moved into place by a rename. On any failure one line on stderr, exit 1.
// The version defaults to the plugin manifest's beside this script; the repository to gurinderu/craft.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { download } from './http-download.mjs'
import { runIfMain } from './script-main.mjs'

const DEFAULT_REPO = 'gurinderu/craft'
const USAGE = 'usage: craft-bin ensure [--version <v>] [--repo <owner/name>]'

/** The release target of each platform the workflow builds for, by `${process.platform}-${process.arch}`. */
const TARGETS = /** @type {Record<string, string>} */ ({
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
})

/** @param {string} platform @param {string} arch @returns {string} */
export function targetOf(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) throw new Error(`no released craft binary for ${platform}/${arch} (only linux and darwin on x64 and arm64); build it from cli/ and pass craftBin`)
  return target
}

/** The version and repository `ensure` was asked for. @param {string[]} argv @returns {{ version: string, repo: string }} */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv
  if (cmd !== 'ensure') throw new Error(USAGE)
  const opts = flags(rest)
  opts.version ||= pluginVersion()
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

/** The version in the plugin manifest beside this script, '' when unreadable. @returns {string} */
function pluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : ''
  } catch { return '' }
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
  const bin = path.join(dir, 'craft')
  if (isExecutable(bin)) return bin
  const asset = `craft-${targetOf(platform, arch)}.tar.gz`
  const archive = await fetchVerified(baseUrl ?? `https://github.com/${repo}/releases/download/v${version}`, asset)
  install(archive, asset, dir, bin)
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
 * `craft` unpacked from `archive` beside `bin`, made executable and renamed into place: no half-written binary
 * is ever at `bin`. @param {Buffer} archive @param {string} asset @param {string} dir @param {string} bin
 */
function install(archive, asset, dir, bin) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(dir, '.fetch-'))
  try {
    const file = path.join(tmp, asset)
    fs.writeFileSync(file, archive)
    try { execFileSync('tar', ['-xzf', file, '-C', tmp, 'craft'], { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (e) {
      const said = String(/** @type {{ stderr?: unknown }} */ (e).stderr ?? '').trim().split('\n')[0]
      throw new Error(`could not unpack craft from ${asset}${said ? `: ${said}` : ''}`)
    }
    const unpacked = path.join(tmp, 'craft')
    if (!fs.lstatSync(unpacked).isFile()) throw new Error(`craft in ${asset} is not a regular file`)
    fs.chmodSync(unpacked, 0o755)
    fs.renameSync(unpacked, bin)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} [_env]
 * @param {{ home?: string, baseUrl?: string, platform?: string, arch?: string }} [deps]  injected by tests
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, deps = {}) {
  try {
    return { exitCode: 0, stdout: [await ensure({ ...parseArgs(argv), ...deps })], stderr: [] }
  } catch (e) {
    return { exitCode: 1, stdout: [], stderr: [`craft-bin: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')}`] }
  }
}

await runIfMain(import.meta.url, run)
