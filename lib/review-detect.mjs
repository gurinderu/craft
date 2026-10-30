// The review's first step (src/review.js, Scout phase): resolve the diff base, the changed files, the authors' spec
// and the run's branch and head — or refuse an ambiguous scope before anything is dispatched.
import { memoryRecord } from './memory-recall.mjs'
import { decodeGitPath } from './lens-scope.mjs'
import { summarizeFindings, branchFromAbbrevRef } from './run-record.mjs'
import { shq } from './run-logging.mjs'
import { REPO_REFUSED_CLASS } from './repo-arg.mjs'
import { DETECT_SCHEMA } from './review-schemas.mjs'

/**
 * @typedef {import('./review-schemas.mjs').DetectAnswer} DetectAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */

/**
 * The detected change, or the report of the exit that stopped the run.
 * @param {ReviewRun} reviewRun
 */
export async function detectPhase(reviewRun) {
const { craftVersion, baseArg, pathArg, repoRefused, ambiguousPath, scopeNotRun, scopeSection, viaArg, ragent, logRun, out, extraLensesNotRun, depthRecordFields } = reviewRun
const { phase: enterPhase, budget: tokenBudget } = reviewRun.sb
// ================= Detect base + languages =================
enterPhase('Scout')
// An absolute `path` with no `repo` to decide it against: refuse BEFORE the first agent is
// dispatched. Zero cost, and the caller is told the two spellings that are unambiguous — against a
// run that guesses, which costs a full fan-out and then reports a scope nobody asked for.
async function ambiguousPathExit() {
  const msg = `path=${ambiguousPath} is an absolute path and no \`repo\` was given, so it is ambiguous: it could name the REPOSITORY to review (pass it as \`repo\`) or a directory INSIDE the repository to narrow to (pass it relative to the repo root). Nothing ran — re-dispatch with one of those two spellings.`
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict: 'INCOMPLETE (ambiguous path)', findings: summarizeFindings([]), dimensions: [], verification: null,
    // The CLASS, not this run's path — `notRun` is ranked by exact string (see `scopeNotRun`).
    // The path itself is in the verdict prose below, where nothing ranks it.
    uncoveredFiles: [], notRun: ['an absolute `path` with no `repo` — ambiguous scope, nothing ran', ...extraLensesNotRun('the scope path is ambiguous')], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — ${msg}`].join('\n'))
}
// A `repo` no agent could `cd` to (lib/repo-arg.mjs): refused the same way, the logger the only agent
// (realm @nick/craft, nodes #159, #411).
async function repoRefusedExit() {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict: 'INCOMPLETE (argument refused)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: [], notRun: [REPO_REFUSED_CLASS, ...extraLensesNotRun('the repo argument was refused')], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — ${repoRefused}`].join('\n'))
}
async function detectDiedExit() {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict: 'INCOMPLETE (detect died)', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: ['base/changed-files detection', ...scopeNotRun, ...extraLensesNotRun('change detection died')], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — the base-resolution agent died twice (API error); nothing was reviewed. Re-run the review.`].join('\n') + scopeSection())
}
/** @returns {Promise<{ exit: string, detected: null } | { exit: null, detected: DetectAnswer }>} */
async function detectChanges() {
  if (repoRefused) return { exit: await repoRefusedExit(), detected: null }
  if (ambiguousPath) return { exit: await ambiguousPathExit(), detected: null }
  const detectorAnswer = await ragent(
    `You are resolving the review base and the changed files. Use shell + read only — do NOT review.${pathArg ? `\n\nSCOPE: consider ONLY files under ${shq(pathArg)}; pass \`-- ${shq(pathArg)}\` to the git commands below.` : ''}
1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. List the changed file paths: \`git diff --name-only <base>...HEAD\`${pathArg ? ` -- ${shq(pathArg)}` : ''} (and include uncommitted changes from \`git status --porcelain\` if the tree is dirty).
3. Capture the VERBATIM change description as \`spec\` — the authors' own written claims/invariants, checked against code later. If the current branch has an OPEN PR, run \`gh pr view --json body,title\` and use its title + body. Otherwise use the commit messages on the diff range: \`git log <base>..HEAD --format=%B\`. Do not summarize or paraphrase — copy the text as-is. Truncate to ~4000 chars. Empty string if there is no PR and no commit body (e.g. only uncommitted changes). If \`gh\` is missing/unauthenticated, fall through to the commit messages.
4. Capture \`branch\` = \`git rev-parse --abbrev-ref HEAD\` (empty string if detached) and \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo). The logger reads both off the working copy with git when a record is written, and its values win; \`head\` also tells it which commit the run started on, so an empty \`head\` files no verdict for that commit.
5. Set \`baseIsHead\`: true when \`git rev-parse '<base>^{commit}'\` and \`git rev-parse HEAD\` print the same sha, else false. This one is NOT a fallback: the run reads it to tell a review launched on the trunk itself from any other empty diff.
Return baseRef (the ref you resolved, empty string if none), files (the changed paths), spec (the verbatim description), branch, head, and baseIsHead.`,
    { label: 'detect', schema: DETECT_SCHEMA, model: 'haiku', effort: 'low' },
  )
  // If base resolution died even after the retry, say so loudly — falling through would
  // produce a misleading "Approve — no supported language" on an empty file list.
  if (!detectorAnswer) return { exit: await detectDiedExit(), detected: null }
  return { exit: null, detected: detectorAnswer }
}
const detection = await detectChanges()
if (detection.exit !== null) return { exit: detection.exit }
const detected = detection.detected
/** What the detect agent resolved, normalised: the base, the changed files, the spec and the run's identity. @param {DetectAnswer} detectedIn */
function detectedChange(detectedIn) {
  const detectedBase = detectedIn.baseRef ?? baseArg
  // DECODED HERE, at the source, before anything asks what a file is. The list comes back as git
  // printed it, and git C-quotes any name holding a space or a non-ASCII character — so the string
  // ends in `"`, `detect` sees no `.rs` suffix, the shared-suffix test sees no `.lock`, and the file
  // belongs to no profile and enters no slice. Decoding it further downstream, at the point the
  // pathspec is rendered, was the first attempt and it could never fire: the name had already been
  // filtered out. Normalising once here also corrects which profiles are considered active and which
  // files are reported as covered by none.
  const detectedFiles = (Array.isArray(detectedIn.files) ? detectedIn.files : []).map(decodeGitPath)
  // The authors' OWN written spec (PR body/title or commit messages) — checked claim-by-claim
  // against the code by the intent lens. The one-line inferred `intent` is not enough: precise
  // claims ("never fails on X", "the only way to Y", "idempotent no-op") live in the full body.
  const detectedSpec = (typeof detectedIn.spec === 'string' ? detectedIn.spec : '').slice(0, 4000)
  // The detect agent runs `git rev-parse --abbrev-ref HEAD`, which prints the literal string "HEAD" on
  // a DETACHED HEAD — a non-branch. Route it through the same rule gitIdentity applies (branchFromAbbrevRef,
  // from lib/run-record.mjs) so a detached run resolves to '' BEFORE this value becomes both
  // the record branch (below) and the prior-round `--branch` flag: a non-empty "HEAD" would pass the
  // no-branch guard and wrongly chain unrelated detached contexts to each other (realm @nick/craft #104).
  const detectedBranch = branchFromAbbrevRef((typeof detectedIn.branch === 'string' ? detectedIn.branch : '').trim())
  const detectedHead = (typeof detectedIn.head === 'string' ? detectedIn.head : '').trim()
  return { baseRef: detectedBase, changedFiles: detectedFiles, spec: detectedSpec, branch: detectedBranch, head: detectedHead }
}
const { baseRef, changedFiles, spec, branch, head } = detectedChange(detected)
reviewRun.startHead = head
return { exit: null, detected, baseRef, changedFiles, spec, branch, head }
}
