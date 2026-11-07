// The git half of lib/craft-source.mjs (realm @nick/craft, node #430): a shallow, prompt-free copy of a system's
// source at a tag or a commit, placed in the cache atomically. A branch is refused: the cache keys a copy by its
// revision and reuses it forever, so a moving name would be served stale (#430: a tag or a commit, never a
// branch). Leftover temporary copies of a run that died are swept once they are an hour old.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isCommitId, refFault } from './external-source-spec.mjs'

const GIT_TIMEOUT_MS = 300_000
const MAX_BUFFER = 16 * 1024 * 1024
// A temporary copy older than this belongs to a run that died, not to one still cloning (git gives up at 300s).
export const STALE_TMP_MS = 60 * 60 * 1000

/** @typedef {(cmd: string, args: string[]) => string} Exec  runs a command, its stdout; throws on a non-zero exit or the timeout */

/** @param {NodeJS.ProcessEnv} env @returns {Exec} */
export const execGit = env => (cmd, args) => execFileSync(cmd, args, { env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })

/** git that never prompts: no terminal for https, batch mode for ssh unless the caller set its own command. @param {NodeJS.ProcessEnv} env */
export function gitEnv(env) {
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...(env['GIT_SSH_COMMAND'] ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) }
}

/** @param {string} p */
const isDir = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** Why git failed, one line. @param {unknown} e */
function gitFault(e) {
  const err = /** @type {{ code?: unknown, stderr?: unknown, message?: unknown, signal?: unknown }} */ (e ?? {})
  if (err.code === 'ENOENT') return 'git not found on PATH'
  if (err.signal === 'SIGTERM') return `git timed out after ${GIT_TIMEOUT_MS / 1000}s`
  const line = String(err.stderr ?? '').split('\n').map(l => l.trim()).filter(Boolean).pop()
  return `git failed: ${line || String(err.message ?? e)}`.slice(0, 300)
}

/** Whether the remote lists the tag `ref`. @param {Exec} exec @param {string} url @param {string} ref */
function listsTag(exec, url, ref) {
  /** @type {string} */
  let listed
  try { listed = exec('git', ['ls-remote', '--tags', '--', url, `refs/tags/${ref}`]) } catch (e) { throw new Error(gitFault(e)) }
  return String(listed).split('\n').some(l => l.split('\t')[1] === `refs/tags/${ref}`)
}

/** The `v`-prefixed spelling of a bare version (`1.12.3` → `v1.12.3`), '' when there is none to try. @param {string} ref */
export const vSpelling = ref => (/^[0-9]/.test(ref) && !refFault(`v${ref}`) ? `v${ref}` : '')

/**
 * The revision to fetch: a full commit id as it is, a tag the remote lists, else that tag's `v` spelling when the
 * remote lists it (a chart reads `1.12.3` where upstream tags `v1.12.3`); throws when it is neither.
 * @param {Exec} exec @param {string} url @param {string} ref @returns {string}
 */
export function resolveRevision(exec, url, ref) {
  if (isCommitId(ref) || listsTag(exec, url, ref)) return ref
  const v = vSpelling(ref)
  if (v && listsTag(exec, url, v)) return v
  throw new Error(`${ref} is not a tag${v ? ` (nor is ${v})` : ''} or a commit — a branch would be cached stale`)
}

/**
 * A shallow checkout of `url` at `ref` into the new directory `tmp`, without `.git`. A tag is fetched by its full
 * ref name, as a commit by its id: `clone --branch <name>` would take a branch of the same name first.
 * @param {Exec} exec @param {string} url @param {string} ref @param {string} tmp
 */
function checkout(exec, url, ref, tmp) {
  exec('git', ['init', '-q', '--', tmp])
  exec('git', ['-C', tmp, 'fetch', '-q', '--depth', '1', '--', url, isCommitId(ref) ? ref : `refs/tags/${ref}`])
  exec('git', ['-C', tmp, '-c', 'core.symlinks=false', '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD'])
  fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true })
}

/** Removes `<target>.tmp-*` siblings older than STALE_TMP_MS. @param {string} target @param {number} now */
export function sweepStaleTmp(target, now) {
  const dir = path.dirname(target)
  const prefix = `${path.basename(target)}.tmp-`
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue
    const p = path.join(dir, name)
    try {
      if (now - fs.lstatSync(p).mtimeMs > STALE_TMP_MS) fs.rmSync(p, { recursive: true, force: true })
    } catch { /* gone already: another run swept it */ }
  }
}

/**
 * The cached copy of `ref`, at the path `targetOf` gives a revision: reused when present (its `v` spelling's too,
 * once a run resolved it), else the revision resolved (resolveRevision), the source fetched into a temporary
 * sibling and renamed into place; stale leftovers are swept either way. The revision answered is the resolved one.
 * @param {Exec} exec @param {string} url @param {string} ref @param {(ref: string) => string} targetOf @param {number} [now]
 * @returns {{ ref: string, dir: string }}
 */
export function cachedCopy(exec, url, ref, targetOf, now = Date.now()) {
  const v = isCommitId(ref) ? '' : vSpelling(ref)
  for (const r of v ? [ref, v] : [ref]) {
    const at = targetOf(r)
    if (isDir(at)) {
      sweepStaleTmp(at, now)
      return { ref: r, dir: at }
    }
  }
  const resolved = resolveRevision(exec, url, ref)
  return { ref: resolved, dir: placeCopy(exec, url, resolved, targetOf(resolved), now) }
}

/** Fetches `ref` into a temporary sibling of `target` and renames it into place. @param {Exec} exec @param {string} url @param {string} ref @param {string} target @param {number} now */
function placeCopy(exec, url, ref, target, now) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  sweepStaleTmp(target, now)
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  /** @param {string} why @returns {string} */
  const dropTmp = why => {
    fs.rmSync(tmp, { recursive: true, force: true })
    // Another run placed the same copy first: take it.
    if (isDir(target)) return target
    throw new Error(why)
  }
  try { checkout(exec, url, ref, tmp) } catch (e) { return dropTmp(gitFault(e)) }
  try { fs.renameSync(tmp, target) } catch (e) { return dropTmp(`could not place the copy: ${e instanceof Error ? e.message : String(e)}`) }
  return target
}
