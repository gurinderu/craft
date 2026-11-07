// The Claude Code delivery without symlinks. integrations/claude-code reaches the shared skills/, lib/, content/,
// src/ and README.md through git symlinks; a clone made with core.symlinks=false (the Windows default) holds
// one-line text files in their place, and the harness copies those into its plugin cache as they are. So each
// release commits the delivery, every link dereferenced into real files, as the whole tree of one commit on a
// branch of its own (`claude-code-plugin`); the marketplace entry's `github` source names that branch, and a
// consumer's clone of it has nothing to dereference.
//
// Run: node lib/materialize-claude-code.mjs --branch <name> --message <text>
//   in a clean checkout of the release tag: materializes integrations/claude-code, commits it as the next commit
//   of refs/heads/<name> (its parent the branch's current head, when there is one), and prints the commit. A tree
//   equal to the head's commits nothing. Pushing the branch is the caller's.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outputLines, runIfMain } from './script-main.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DELIVERY = path.join('integrations', 'claude-code')
const USAGE = 'usage: materialize-claude-code --branch <name> --message <text>'

/**
 * A copy of `root`'s Claude Code delivery with every symlink dereferenced, as an install from a clone with
 * symlinks lays it out.
 * @param {string} root @param {string} into  an empty directory @returns {string} the copy's root
 */
export function materialize(root, into) {
  const copy = path.join(into, 'claude-code')
  copyDereferenced(path.join(root, DELIVERY), copy)
  return copy
}

/**
 * `src` copied to `dst` through every symlink (fs.cpSync's `dereference` keeps the links below the top level).
 * The file mode is kept, so an executable stays one in the commit.
 * @param {string} src @param {string} dst
 */
function copyDereferenced(src, dst) {
  if (!fs.statSync(src).isDirectory()) { fs.copyFileSync(src, dst); return }
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) copyDereferenced(path.join(src, name), path.join(dst, name))
}

/** @typedef {(args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv }) => { status: number | null, stdout: string, stderr: string }} Git */

/** @type {Git} */
function spawnGit(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') }
}

/**
 * @param {Git} git @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string} trimmed stdout
 */
function must(git, args, opts) {
  const r = git(args, opts)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.status}`}`)
  return r.stdout.trim()
}

/**
 * The materialized delivery committed as the next commit of `branch` in `root`'s repository.
 * @param {{ root: string, branch: string, message: string, git?: Git }} o
 * @returns {{ commit: string, changed: boolean }}
 */
export function commitBranch({ root, branch, message, git = spawnGit }) {
  // Only what the tag tracks may ship: an untracked or ignored file in the checkout would be copied in too.
  const dirty = must(git, ['status', '--porcelain', '--ignored'], { cwd: root })
  if (dirty) throw new Error(`the checkout is not clean, refusing to materialize it:\n${dirty}`)
  const gitDir = must(git, ['rev-parse', '--absolute-git-dir'], { cwd: root })
  const ref = `refs/heads/${branch}`
  must(git, ['check-ref-format', ref])
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cc-branch-'))
  try {
    const copy = materialize(root, tmp)
    // Its own index and work tree: the checkout's index and files stay as they are.
    const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: copy, GIT_INDEX_FILE: path.join(tmp, 'index') }
    // --force: a global excludes file on the machine must not drop a shipped file.
    must(git, ['add', '--all', '--force', '.'], { cwd: copy, env })
    const tree = must(git, ['write-tree'], { cwd: copy, env })
    const head = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root })
    const parent = head.status === 0 ? head.stdout.trim() : ''
    if (parent && must(git, ['rev-parse', `${parent}^{tree}`], { cwd: root }) === tree) return { commit: parent, changed: false }
    const commit = must(git, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { cwd: root })
    // The old value guards a branch moved under this run.
    must(git, ['update-ref', ref, commit, parent || '0'.repeat(commit.length)], { cwd: root })
    return { commit, changed: true }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * @param {string[]} argv @returns {{ branch: string, message: string }}
 */
export function parseArgs(argv) {
  let branch = '', message = ''
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (v === undefined || v === '') throw new Error(USAGE)
    if (k === '--branch') branch = v
    else if (k === '--message') message = v
    else throw new Error(USAGE)
  }
  if (!branch || !message) throw new Error(USAGE)
  return { branch, message }
}

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: git inherits the process environment
 * @param {{ root?: string, git?: Git }} [deps]  injected by tests
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, { root = ROOT, git = spawnGit } = {}) {
  const o = outputLines()
  try {
    const { branch, message } = parseArgs(argv)
    const { commit, changed } = commitBranch({ root, branch, message, git })
    o.stdout.push(changed ? `materialize-claude-code: ${branch} at ${commit}` : `materialize-claude-code: ${branch} unchanged at ${commit}`)
    return { exitCode: 0, ...o }
  } catch (e) {
    o.stderr.push(`materialize-claude-code: ${e instanceof Error ? e.message : String(e)}`)
    return { exitCode: 1, ...o }
  }
}

await runIfMain(import.meta.url, run)
