// What craft's PreToolUse hook says on a Bash `git push` (realm @nick/craft, node #299, point 4; the consumer
// observation it answers, #298): a fix round pushed to a PR under review with no craft review of that head. It
// never blocks — one line of context, the permission flow untouched. Same repo test and off switch as the work hook
// (#275, #288). "Under review" is read locally, with no network: the pushed branch is not a trunk and its
// remote-tracking ref exists (a branch already pushed stands in for an open PR). "Reviewed" is a run-store line
// (~/.craft/runs/index.jsonl, lib/run-record.mjs indexProjection) of a top-level, clean-tree review of this project
// (keyed by lib/repo-key.mjs, as the record is) whose reviewed head is the pushed commit — a light re-review files the
// same line. The reviewed head is the commit the run read, observed at its first checkpoint and held to the head it
// started on, not the write-time `head`: a background review files after the session may have committed a fix it never
// saw. Only craft:review files that observation — craft:adversarial-review checkpoints nothing — so an adversarial
// review's verdict does not silence the line.
import { harness } from './hook-harness.mjs'
import { pushesIn } from './push-command.mjs'
import { repoTest } from './work-hook.mjs'

export const PUSH_REASON = 'push-no-verdict'
const EVENT = 'PreToolUse'
const TRUNKS = new Set(['main', 'master', 'trunk'])
// The `push.default` modes that push the current branch to its upstream's name.
const UPSTREAM_MODES = new Set(['upstream', 'tracking'])
// The engine whose record is a review verdict: craft:review (any depth), the one that files a reviewed head.
const REVIEW_NAMES = new Set(['review'])

/**
 * `git(args, cwd)` is git's trimmed stdout, or null when it fails; `index()` the run store's index lines.
 * @typedef {{ git: (args: string[], cwd: string) => string | null, index: () => Array<Record<string, unknown>> }} PushDeps
 * @typedef {import('./hook-log.mjs').HookEntry} HookEntry
 * @typedef {{ stdout: string, entry: HookEntry | null }} HookRun
 */

/** @param {unknown} v @returns {string} */
const str = v => (typeof v === 'string' ? v : '')

/**
 * The line the hook adds, in the harness's words: Codex has no Workflow tool, so its session reviews the fix itself.
 * Claude Code hands a PreToolUse hook's context to the model only after the tool ran (observed, Claude Code
 * 2.1.296, `claude -p --include-hook-events`; realm @nick/craft, #289), so the line speaks of a push already made.
 * @param {string} sha @param {string} [who] @returns {string}
 */
export function pushText(sha, who = 'claude-code') {
  const short = sha.slice(0, 8)
  const how = who === 'codex' ? 'review the pushed fix commits yourself (the diff since the last reviewed head)' : 'review the pushed fix commits (a light re-review, craft:review)'
  return `craft: this push had no complete craft verdict on ${short}; ${how} before replying or requesting review.`
}

/**
 * Whether the index holds a top-level review verdict of `project` at `sha` (a reviewed head of 7+ characters
 * matches as a prefix). A run that did not fully run is no verdict: INCOMPLETE anywhere in it, a red one marked
 * `(INCOMPLETE)` included, and a record rebuilt from a transcript, `(candidates)` (realm @nick/craft, node #299).
 * The head is `reviewedHead`, what the run read when it started (lib/craft-log-run.mjs, reviewedTree); a record
 * without one (older records, a run that checkpointed nothing, any `write`) is no verdict. A run whose tracked
 * files were edited when it started (`reviewedDirty`, untracked files aside) reviewed more than that commit, so
 * it is no verdict on it either — and fixes reviewed uncommitted, then committed, warn falsely (a known cost).
 * @param {Array<Record<string, unknown>>} lines @param {string} project @param {string} sha @returns {boolean}
 */
export function hasVerdict(lines, project, sha) {
  return lines.some(e => {
    const head = str(e['reviewedHead'])
    const verdict = str(e['verdict'])
    return e['kind'] === 'workflow' && REVIEW_NAMES.has(str(e['name'])) && !e['nested'] && e['reviewedDirty'] === false
      && e['project'] === project && head.length >= 7 && sha.startsWith(head) && verdict !== '' && !/INCOMPLETE|\(candidates\)/i.test(verdict)
  })
}

/**
 * A refspec's source and the branch it lands on: `[+]<src>[:<dst>]`, the destination defaulting to the source
 * (to the current branch for `HEAD`).
 * @param {string} spec @param {string} current @returns {{ src: string, branch: string }}
 */
function refspec(spec, current) {
  const [src = '', dst = ''] = spec.replace(/^\+/, '').split(':')
  const fallback = src === 'HEAD' ? current : src
  return { src, branch: (dst || fallback).replace(/^refs\/heads\//, '') }
}

/**
 * Where a push with no refspec sends the current branch, as `push.default` decides: to its upstream branch
 * (`branch.<name>.merge`) under `upstream`/`tracking`; under `simple` (also when unset) git refuses a push to the
 * upstream's remote when the names differ — null; otherwise (`current`, `matching`, another remote) the same name.
 * @param {import('./push-command.mjs').Push} push @param {string} current @param {PushDeps['git']} git
 * @returns {string | null}
 */
function defaultBranch(push, current, git) {
  const merge = (git(['config', `branch.${current}.merge`], push.dir) ?? '').replace(/^refs\/heads\//, '')
  if (!merge || merge === current) return current
  const mode = git(['config', 'push.default'], push.dir) || 'simple'
  if (UPSTREAM_MODES.has(mode)) return merge
  const upstreamRemote = git(['config', `branch.${current}.remote`], push.dir) ?? ''
  return mode === 'simple' && (!push.remote || push.remote === upstreamRemote) ? null : current
}

/**
 * What a push sends and where: its first refspec as written; with none, the current branch (defaultBranch), or
 * `refused` when git would refuse the push.
 * @param {import('./push-command.mjs').Push} push @param {string} current @param {PushDeps['git']} git
 * @returns {{ src: string, branch: string, refused: boolean }}
 */
function destination(push, current, git) {
  const named = push.refspecs[0]
  if (named) return { ...refspec(named, current), refused: false }
  const branch = current ? defaultBranch(push, current, git) : ''
  return { src: 'HEAD', branch: branch ?? '', refused: branch === null }
}

/**
 * The commit the remote-tracking ref of `branch` names, null when there is none; the remote is the push's own, else
 * the current branch's upstream remote, else `origin`.
 * @param {import('./push-command.mjs').Push} push @param {string} current @param {string} branch
 * @param {PushDeps['git']} git @returns {string | null}
 */
function remoteHead(push, current, branch, git) {
  const remote = push.remote || (current && git(['config', `branch.${current}.remote`], push.dir)) || 'origin'
  return git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], push.dir)
}

/**
 * The commit a push sends and the branch it lands on, or why the hook cannot judge it (`refused`, `detached`, `delete`,
 * `no-commit`, `trunk`, `no-remote-branch`, `up-to-date`).
 * @param {import('./push-command.mjs').Push} push @param {PushDeps['git']} git
 * @returns {{ sha: string, silent: string }}
 */
export function pushTarget(push, git) {
  const current = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], push.dir) ?? ''
  const { src, branch, refused } = destination(push, current, git)
  if (refused) return { sha: '', silent: 'refused' }
  if (src === '') return { sha: '', silent: 'delete' }
  if (!branch) return { sha: '', silent: 'detached' }
  if (TRUNKS.has(branch)) return { sha: '', silent: 'trunk' }
  const sha = git(['rev-parse', '--verify', '--quiet', `${src}^{commit}`], push.dir)
  if (!sha) return { sha: '', silent: 'no-commit' }
  const tracked = remoteHead(push, current, branch, git)
  if (!tracked) return { sha, silent: 'no-remote-branch' }
  return { sha, silent: tracked === sha ? 'up-to-date' : '' }
}

/** @param {string} input @returns {Record<string, unknown>} */
function parse(input) {
  try {
    const v = /** @type {unknown} */ (JSON.parse(input))
    return v !== null && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {}
  } catch { return {} }
}

/** The Bash command, a string or an argument array. @param {Record<string, unknown>} fields @returns {string} */
function commandOf(fields) {
  const toolInput = fields['tool_input']
  const raw = toolInput !== null && typeof toolInput === 'object' ? /** @type {Record<string, unknown>} */ (toolInput)['command'] : ''
  return Array.isArray(raw) ? raw.map(str).join(' ') : str(raw)
}

/** @param {string} text @returns {string} */
const output =text => JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } })

/**
 * One PreToolUse run over the harness's JSON input: a command with no `git push` is not logged; a push is, with
 * the repo test's silence, why it could not judge the push, `verdict` when the head was reviewed, or the line it
 * spoke (`reason: push-no-verdict`). Only the first push of a command is judged.
 * @param {string} input @param {Record<string, string | undefined>} env @param {string} fallbackCwd @param {Date} now
 * @param {PushDeps} deps @returns {HookRun}
 */
export function pushHook(input, env, fallbackCwd, now, deps) {
  const fields = parse(input)
  const push = pushesIn(commandOf(fields), str(fields['cwd']) || fallbackCwd)[0]
  if (!push) return { stdout: '', entry: null }
  const base = repoTest(push.dir, str(fields['session_id']), env, now, EVENT, harness(fields, env))
  if (!base.spoke) return { stdout: '', entry: base }
  /** @param {string} why @returns {HookRun} */
  const quiet = why => ({ stdout: '', entry: { ...base, spoke: false, silent: why } })
  if (push.skip) return quiet(push.skip)
  const { sha, silent } = pushTarget(push, deps.git)
  if (silent) return quiet(silent)
  if (hasVerdict(deps.index(), base.repo, sha)) return quiet('verdict')
  return { stdout: output(pushText(sha, base.harness)), entry: { ...base, reason: PUSH_REASON } }
}
