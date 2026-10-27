// The weekly mutation workflow's failure step (.github/workflows/mutation.yml): a red run is reported in
// ONE open issue. While an issue titled "Weekly mutation run failed (…)" is open, each further red run is a
// comment on it (the oldest, if several) with the run link and score; only when none is open is a new one
// created. The score is in the title, so matching whole titles would open one issue per distinct score.
//
// Run: `RUN_URL=<run link> node lib/mutation-issue.mjs reports/mutation/mutation.json` with `gh` on PATH
// and GH_TOKEN set. It reads `gh issue list --json number,title`, an array of { number, title }: the open
// issues whose title carries the phrase (`--state open`, `--search in:title "…"`); the prefix is checked
// again here, since a search matches words anywhere in the title.
//
// `node lib/mutation-issue.mjs --lost-runner <run id>` is the workflow's second job, run only after the job
// `mutation` failed: it files the same way, as `cut off, no report`, unless `gh run view <id> --json jobs`
// shows that job's step `Stryker over lib/` ended `failure` (the first job's to report) or `success` (a
// later step failed after a green run). Cancelled, skipped (a lost runner or a failed install before it) and a
// step it cannot find (a rename in the workflow, which mutation-issue.test.mjs holds against) are filed, the
// conclusion seen named in the issue.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mutationScore } from './mutation-score.mjs'
import { runIfMain } from './script-main.mjs'

const PREFIX = 'Weekly mutation run failed ('
const CUT_OFF = 'cut off, no report'
/** The job and its step as `gh run view --json jobs` names them: the job id (it has no `name:`), the step's `name:`. */
export const MUTATION_JOB = 'mutation'
export const STRYKER_STEP = 'Stryker over lib/'

/** @typedef {{ kind: 'create', title: string, body: string } | { kind: 'comment', number: number, body: string }} IssueAction */

/**
 * @param {{ number: number, title: string }[]} open  the open issues
 * @param {string} score  e.g. `68.95%`, or `no report`
 * @param {string} runUrl
 * @param {string} [detail]  a closing paragraph, e.g. how the Stryker step ended
 * @returns {IssueAction}
 */
export function issueAction(open, score, runUrl, detail) {
  const tail = detail ? `\n\n${detail}` : ''
  const ours = open.filter(i => i.title.startsWith(PREFIX)).sort((a, b) => a.number - b.number)[0]
  if (ours) return { kind: 'comment', number: ours.number, body: `Failed again: ${runUrl}\n\nScore: ${score}.${tail}` }
  return {
    kind: 'create',
    title: `${PREFIX}${score})`,
    body: `The weekly mutation run failed: ${runUrl}\n\nScore: ${score} (the floor is in \`lib/mutation-floor.json\`). Report: the \`mutation-report\` artifact of the run, when there is one — a run cut by its timeout or by a lost runner, or one that failed before Stryker finished, leaves none. Further red runs are commented here while this stays open.${tail}`,
  }
}

/** @param {string} report  a Stryker JSON report's path @returns {string} its score, or `no report` */
function scoreText(report) {
  /** @type {number | null} */
  let score = null
  try { score = mutationScore(JSON.parse(fs.readFileSync(report, 'utf8'))) } catch { score = null }
  return score === null ? 'no report' : `${score.toFixed(2)}%`
}

/**
 * @param {string} stdout  what `gh run view <id> --json jobs` prints
 * @returns {string | null} the conclusion of the job `mutation`'s step `Stryker over lib/`, null when not listed
 */
export function strykerConclusion(stdout) {
  /** @type {{ jobs?: { name?: unknown, steps?: { name?: unknown, conclusion?: unknown }[] }[] }} */
  const v = JSON.parse(stdout)
  const step = (v.jobs ?? []).find(j => j.name === MUTATION_JOB)?.steps?.find(s => s.name === STRYKER_STEP)
  return typeof step?.conclusion === 'string' ? step.conclusion : null
}

/** @param {string} stdout @returns {{ number: number, title: string }[]} @throws {Error} on any other shape */
function parseListing(stdout) {
  /** @type {unknown} */
  const v = JSON.parse(stdout)
  const ok = Array.isArray(v) && v.every(i => !!i && typeof i === 'object' && typeof i.number === 'number' && typeof i.title === 'string')
  if (!ok) throw new Error('gh issue list did not print an array of { number, title }')
  return /** @type {{ number: number, title: string }[]} */ (v)
}

/**
 * Comment on the open mutation issue, or create one.
 * @param {{ report: string, runUrl: string, gh: (args: string[]) => string, score?: string, detail?: string }} io
 *   `score`, when given, stands in for the report's; `detail` closes the body
 * @returns {IssueAction}
 */
export function fileMutationIssue({ report, runUrl, gh, score, detail }) {
  const open = parseListing(gh(['issue', 'list', '--state', 'open', '--limit', '200', '--search', `in:title "${PREFIX.slice(0, -2)}"`, '--json', 'number,title']))
  const a = issueAction(open, score ?? scoreText(report), runUrl, detail)
  if (a.kind === 'comment') gh(['issue', 'comment', String(a.number), '--body', a.body])
  else gh(['issue', 'create', '--title', a.title, '--body', a.body])
  return a
}

/**
 * @param {string[]} args @param {NodeJS.ProcessEnv} env  gh's environment: PATH finds it, GH_TOKEN signs it in
 * @returns {string} stdout @throws {Error} when gh fails
 */
function gh(args, env) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] })
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} exited ${String(r.status)}`)
  return r.stdout
}

/**
 * The command (realm @nick/craft, #172): the report's path is the first argument, the run link `RUN_URL`.
 * Neither is required — a red run is reported without them, as `no report` and `(run link missing)`.
 * With `--lost-runner <run id>` first, it reports that run's Stryker step unless it ended `failure` or `success`.
 * @param {string[]} argv  the arguments after the script's path
 * @param {NodeJS.ProcessEnv} env
 * @param {(args: string[]) => string} [ghCli]  runs `gh`, by default the one on `env`'s PATH
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export function run(argv, env, ghCli = (args) => gh(args, env)) {
  return Promise.resolve(issue(argv, env, ghCli))
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {(args: string[]) => string} ghCli */
function issue(argv, env, ghCli) {
  try {
    const runUrl = env['RUN_URL'] ?? '(run link missing)'
    /** @type {{ report: string, score?: string, detail?: string }} */
    let io = { report: argv[0] ?? '' }
    if (argv[0] === '--lost-runner') {
      const ended = strykerConclusion(ghCli(['run', 'view', argv[1] ?? '', '--json', 'jobs']))
      if (ended === 'failure' || ended === 'success') return { exitCode: 0, stdout: [`Stryker step ended ${ended}: not cut off, nothing filed`], stderr: [] }
      const detail = ended === null
        ? `The job \`${MUTATION_JOB}\` has no step \`${STRYKER_STEP}\` with a conclusion in this run — renamed in the workflow, or never started.`
        : `The job \`${MUTATION_JOB}\`'s step \`${STRYKER_STEP}\` ended \`${ended}\`.`
      io = { report: '', score: CUT_OFF, detail }
    }
    const a = fileMutationIssue({ ...io, runUrl, gh: ghCli })
    return { exitCode: 0, stdout: [a.kind === 'comment' ? `commented on #${String(a.number)}` : `created: ${a.title}`], stderr: [] }
  } catch (e) {
    return { exitCode: 1, stdout: [], stderr: [`mutation-issue: ${/** @type {Error} */ (e).message}`] }
  }
}

await runIfMain(import.meta.url, run)
