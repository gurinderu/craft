// The discovery CLI's command line (lib/craft-externals.mjs, realm @nick/craft, node #435): the verb, each option
// once and known, an absolute --repo-root, `--known -` only, and --paths as base64url JSON of repo-relative paths.
import path from 'node:path'
import { MANIFESTS_MAX } from './manifest-paths.mjs'

const USAGE = 'usage: craft-externals discover --repo-root <absolute dir> [--paths <base64url JSON list>] [--known -]'

/** The options after the verb, each once and known, else why not. @param {string[]} argv @returns {{ opts: Record<string, string> } | { error: string }} */
function readOptions(argv) {
  /** @type {Record<string, string>} */
  const opts = {}
  for (let i = 1; i < argv.length; i += 2) {
    const k = String(argv[i])
    if (!['--repo-root', '--paths', '--known'].includes(k) || k in opts) return { error: `unexpected option ${JSON.stringify(k)}` }
    opts[k] = String(argv[i + 1])
  }
  return { opts }
}

/** The command line read. @param {string[]} argv @returns {{ repoRoot: string, paths?: string[], known: boolean } | { error: string }} */
export function parseArgv(argv) {
  if (argv[0] !== 'discover' || argv.length % 2 !== 1) return { error: USAGE }
  const read = readOptions(argv)
  if ('error' in read) return read
  const { opts } = read
  const [repoRoot, known] = [opts['--repo-root'] ?? '', '--known' in opts]
  if (!path.isAbsolute(repoRoot)) return { error: '--repo-root is missing or not an absolute path' }
  if (known && opts['--known'] !== '-') return { error: '--known takes only "-" (the records as JSON on stdin)' }
  if (!('--paths' in opts)) return { repoRoot, known }
  const paths = decodePaths(String(opts['--paths']))
  return 'error' in paths ? paths : { repoRoot, paths: paths.list, known }
}

/** --paths decoded: 1..MANIFESTS_MAX repo-relative paths. @param {string} b64 @returns {{ list: string[] } | { error: string }} */
function decodePaths(b64) {
  /** @type {unknown} */
  let list
  try { list = /^[A-Za-z0-9_-]+$/.test(b64) ? JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) : null } catch { list = null }
  const ok = Array.isArray(list) && list.length >= 1 && list.length <= MANIFESTS_MAX
    && list.every(p => typeof p === 'string' && p && !path.isAbsolute(p) && !p.split('/').includes('..'))
  return ok ? { list: /** @type {string[]} */ (list) } : { error: `--paths is not base64url JSON of 1..${MANIFESTS_MAX} repo-relative paths` }
}
