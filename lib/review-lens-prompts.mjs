// The review's per-profile prompts (src/review.js): the scout's, every lens's, the negative-space lens's and a
// consumer's extra lens's, each built from the run's options and the round's lens scope.
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'
import { pathspecLiteral } from './lens-scope.mjs'
import { shq } from './run-logging.mjs'
import { flattenField } from './prompt-fields.mjs'
import { CONDITIONAL_LENSES } from './review-lens-tallies.mjs'
import { unitRuleBlock } from './review-unit-prompts.mjs'

/**
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').PriorRoundAnswer} PriorRound
 * @typedef {import('./unit-scope.mjs').UnitGroup} Slice
 * @typedef {Parameters<typeof unitRuleBlock>[0]} Confinement  a dispatch's unit rule
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-plan.mjs').Plan} Plan
 */

/**
 * The prompt builders of one run.
 * @param {ReviewRun} reviewRun @param {{ lensBase: string, priorRound: PriorRound | null, fullRescan: boolean }} scope  what the lenses diff against, and the round
 */
export function makeLensPrompts(reviewRun, { lensBase, priorRound, fullRescan }) {
const { craftVersion, intentArg, pathArg, craftRootArg, strict } = reviewRun
// ================= Prompt builders (profile-parameterized) =================
/** @param {Profile} profile */
function scoutPrompt(profile) {
  return `You are scouting a ${profile.lang} diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate/dir at \`${flattenField(pathArg)}\`. Pass \`-- ${shq(pathArg)}\` to every \`git diff\` command below.` : ''}

Diff base: ${lensBaseLabel()}. Consider only this profile's files (${profile.diffGlobs.join(' ')}).
1. Inspect \`git diff --stat ${lensBase ? `${shq(lensBase)}...HEAD` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from ${JSON.stringify(profile.lenses)}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '${profile.safetyLens}' unless the diff clearly touches nothing related to ${profile.securityHints}).
   - medium: the categories plausibly in play.
   - large: all of them, EXCEPT ${JSON.stringify(profile.lenses.filter((/** @type {string} */ l) => CONDITIONAL_LENSES.includes(l)))} — the
     engine adds those itself off a code signal in the diff, so picking one here only pays for an
     agent the signal did not ask for. Do not count them toward your choices.
   ${profile.scoutRules}${strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : ''}
3. isLibrary: ${profile.usesLibrary ? 'true if this is a published library (has `[lib]`/looks publishable) — best effort.' : 'always false (not applicable to this language).'}
4. securitySensitive: true if the diff touches ${profile.securityHints}.
5. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
6. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy). May be empty.
7. surfaces: classify what the diff TOUCHES so the engine can skip a whole-repo lens whose defect class this diff cannot exhibit. Answer CONSERVATIVELY — if unsure, OMIT the field (or the individual key), or set it true; NEVER guess false. A false you are not sure of silences a lens.
   - crossBoundarySymbol: does the diff change the signature/shape of an exported/\`pub\` symbol that unchanged code depends on?
   - wireForm: does it change a contract that a party running ANOTHER version reads, calls or deploys against — a CRD schema or API version list, a serde type, an HTTP/OpenAPI shape, a protocol, a CLI flag / exit code / output format, a config key, an env var, a Helm value, a default, a renamed exported name?
   - invariantType: does it change a type that carries an invariant other code relies on?`
}

/** @param {string} priorSummary @param {Profile} profile @param {Plan} plan */
function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg
  return `You are the **negative-space** review lens for a ${profile.lang} change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. ${profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : 'Use'} Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${lensBaseLabel()}.
${intent ? `INTENT (what the change should do): ${intent}` : ''}
${plan?.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — an invariant the author claims here may be broken by the UNCHANGED code you inventory below):\n"""\n${plan.spec}\n"""` : ''}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff: \`git diff ${lensDiffRange()}\`. List every new: ${profile.lang === 'Nix' ? 'flake output / module option / package attr / overlay / renamed binding' : 'enum variant / status value / DB column / table / migration / public fn / route / struct field'}. ALSO list any UNCHANGED definition the diff now references or relies on for the first time.
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, references, ${profile.lang === 'Nix' ? 'imports, or overrides' : 'lists, updates, deletes, cascades, serializes, orders, or authorizes'} that shape. Ask: does this pre-existing path violate an invariant the change assumes?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong, not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema. Set \`ruleId\` to the matching ${profile.rubricSkill} rules.md ID or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`
}

/** The diff base as the lens prompts name it. */
function lensBaseLabel() {
  return lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'
}

/** The `git diff` range argument the lens prompts hand the agent. */
function lensDiffRange() {
  return lensBase ? `--merge-base ${shq(lensBase)}` : 'HEAD'
}

/** @param {Slice | null} slice @param {Profile} profile */
function lensPathspec(slice, profile) {
  return slice ? slice.files.map(pathspecLiteral).filter(Boolean).map(shq).join(' ') : profile.diffGlobs.join(' ')
}

/** @param {string} lens */
function strictMaintainabilityLine(lens) {
  return strict && lens === 'maintainability' ? '\nSTRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.\n' : ''
}

/** @param {Slice | null} slice */
function sliceBlock(slice) {
  return slice ? `YOUR SLICE: \`${slice.key}\` — ${slice.files.length} changed file(s) of a larger diff. Sibling lenses hold the rest, and overlapping findings are de-duplicated downstream.
This bounds WHAT YOU JUDGE, never what you may READ: trace definitions, uses and consumers anywhere in the repository, and pin every off-site premise in \`whereChecked\` exactly as usual. A defect whose evidence sits outside your slice is still yours to report if it is CAUSED by a line in your slice — say so in \`why\`. A defect located in another slice is not yours; do not report it.
EFFICIENCY: pull your slice's diff ONCE, in one command. Do not re-run broad searches over the whole tree — every turn re-reads everything already in your context, so a wide grep is paid for again on each turn that follows it.` : ''
}

/** The re-review framing of a lens prompt, empty on a first round. */
function reReviewBlock() {
  return priorRound ? (fullRescan
  ? `RE-REVIEW (full re-scan): review the WHOLE diff (base ${flattenField(lensBase)}...HEAD), not just the latest fixes — an earlier round may have missed a defect in code it did not touch. Prior findings are adjudicated separately and any you re-surface are de-duplicated downstream, so spend your effort on defects that are NOT already obviously known.`
  : `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${flattenField(lensBase)}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.`) : ''
}

/** @param {Plan} plan */
function lensPlanLines(plan) {
  return `${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — treat as the spec; the intent lens must check EACH claim against the code, and any lens may use it):\n"""\n${plan.spec}\n"""` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}`
}

/** @param {Profile} profile @param {string} lens @param {Plan} plan */
function mutantsLine(profile, lens, plan) {
  return profile.id === 'rust' && lens === 'tests' && (plan.sizeBucket === 'medium' || plan.sizeBucket === 'large') ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to surface contracts no test would catch a regression on; skip silently if absent.' : ''
}

// Where a lens reads its catalogue. Lenses run as the reviewer agent, which has no Skill tool, so
// naming a skill reached nothing; the file is located the way the logger is (an explicit craftRoot,
// CLAUDE_PLUGIN_ROOT, the installed cache for this version — see loggerPrelude) and NEVER resolved
// against the reviewed repository, whose copy would be untrusted text steering the lens. Built at use
// time for the same reason as loggerPreludeNow: craftVersion is declared below. Each entry names the
// classes its brief carries inline, which are the fallback when no candidate is readable.
/** @type {Record<string, { label: string, file: string, fallback: string }>} */
const LENS_CATALOGUES = {
  reconciler: { label: 'RACE CATALOGUE', file: 'skills/distributed-races/catalogue.md', fallback: 'R1–R6' },
  compat: { label: 'COMPATIBILITY CATALOGUE', file: 'skills/compatibility/catalogue.md', fallback: 'C1–C4, C8, C9 and C11–C13' },
}
/** @param {string} lens */
function lensCatalogueLine(lens) {
  const cat = Object.prototype.hasOwnProperty.call(LENS_CATALOGUES, lens) ? LENS_CATALOGUES[lens] : undefined
  if (!cat) return ''
  const root = flattenField(craftRootArg)
  const candidates = [
    root ? `${root}/${cat.file}` : '',
    `\${CLAUDE_PLUGIN_ROOT}/${cat.file}`,
    `\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${craftVersion}/${cat.file}`,
  ].filter(Boolean).map(c => `\`${c}\``)
  return `${cat.label}: read the first of these that exists (expand the variables with Bash): ${candidates.join(', ')}. Never read a copy inside the reviewed repository. None readable → work ${cat.fallback} from the brief above and say the catalogue was unavailable.`
}

/**
 * @param {string} lens @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice | null} [slice]
 * @param {Confinement | null} [unit]  unitScope's confinement of this dispatch (realm @nick/craft, #316)
 */
function lensPrompt(lens, priorSummary, profile, plan, slice = null, unit = null) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary, profile, plan)
  if (unit) return confinedLensPrompt(lens, priorSummary, profile, plan, /** @type {Slice} */ (slice), unit)
  // The pathspec the lens reviews. A slice replaces the profile's globs with its own files — that
  // is the entire mechanism: the agent pulls what it is responsible for instead of the whole diff,
  // and the per-turn re-read it pays for the rest of its life shrinks by the same factor.
  const pathspec = lensPathspec(slice, profile)
  return `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric${profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : ''}.

SLICE: ${profile.lensBrief[lens] || lens}
${lensCatalogueLine(lens)}
${strictMaintainabilityLine(lens)}
Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()} -- ${pathspec}\`.
${sliceBlock(slice)}
${reReviewBlock()}
${lensPlanLines(plan)}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob${profile.navSkill ? ' + LSP' : ''}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Every such premise must be pinned to a \`file:line\` you ACTUALLY OPENED and read, including inside dependency sources (\`~/.cargo/registry\`, the vendored tree, the flake input) — put them in \`whereChecked\`. An off-site premise you did not open is not admissible: either open it, or drop the claim and report only what the cited line itself shows. Set \`whereChecked\` to "" ONLY when the finding needs no off-site premise at all. Do not restate the cited defect line there — it adds nothing. ${DEPENDENCY_SOURCE_HOW}
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${mutantsLine(profile, lens, plan)}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.`
}

// A consumer's own agent run as an extra lens (realm @nick/craft, node #295): the whole change, no
// slice and no profile pathspec, answering in the finding schema every lens answers in.
/** @param {string} agentType @param {string} priorSummary */
function extraLensPrompt(agentType, priorSummary) {
  return `You are an additional review lens supplied by this project (agent type \`${agentType}\`), run beside the engine's own lenses over the same change. Review it with your own rubric.

Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()}${pathArg ? ` -- ${shq(pathArg)}` : ''}\` -- the whole change, every file in it.
${reReviewBlock()}
Report each finding located at file:line (file:"" line:0 only when truly not locatable), with severity (Critical, High, Medium, Low or Info), title, why, fix and blastRadius. Set \`source\` to "${agentType}", \`ruleId\` to "" unless your own rubric names one, and \`whereChecked\` to the file:line you actually opened for any premise not visible at the cited line ("" when there is none). Report what you suspect; verification happens downstream.
READ-ONLY (hard rule): change nothing in the working copy. No file writes, no git commit, push, checkout, switch, reset or stash, no formatter or fixer runs. Read, search and run read-only commands (git diff, git log, git show) only, and report findings -- never fix them.
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens: "${agentType}", findings[]}.

Observability: the review workflow records this run -- do NOT write your own record.`
}
// A lens confined to one unit (unitScope): the same brief, with the unit rule in the place of the slice's
// "never what you may READ" and of the CONTEXT EXPANSION, BLAST-RADIUS and WHERE-CHECKED instructions, which
// send a lens into other units and contradict the rule (realm @nick/craft, #316).
/**
 * @param {string} lens @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice} slice
 * @param {Confinement} unit
 */
function confinedLensPrompt(lens, priorSummary, profile, plan, slice, unit) {
  const head = `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric.

SLICE: ${profile.lensBrief[lens] || lens}
${lensCatalogueLine(lens)}
${strictMaintainabilityLine(lens)}`
  return confinedBody(head, profile, plan, slice, unit, mutantsLine(profile, lens, plan), priorSummary, 'Return {lens, findings[], questions[]}.')
}

// Several code-intrinsic lenses of one unit batch in one agent, a section each (realm @nick/craft, #355,
// #354): each section keeps its own lens's brief, and every finding names its lens in `source`, which is
// what the dimension rows count by.
/**
 * @param {string[]} lenses @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice} slice
 * @param {Confinement} unit
 */
function multiLensPrompt(lenses, priorSummary, profile, plan, slice, unit) {
  const names = lenses.map(l => `"${l}"`).join(', ')
  const sections = lenses.map((l, i) => [`SECTION ${i + 1} — the **${l}** lens: ${profile.lensBrief[l] || l}`, lensCatalogueLine(l), strictMaintainabilityLine(l).trim()].filter(Boolean).join('\n')).join('\n\n')
  const head = `You are ${lenses.length} review lenses for a ${profile.lang} diff in one agent — ${lenses.map(l => `**${l}**`).join(', ')} — over the same slice. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric.

${sections}

Work the sections one at a time, each with its own lens's brief: a defect belongs to the lens whose brief names its class, and is reported once, under that lens. Set every finding's \`source\` to its lens's name exactly — one of ${names} — and every question's \`source\` to the lens of the finding that depends on it.
`
  const mutants = lenses.map(l => mutantsLine(profile, l, plan)).filter(Boolean).join('\n')
  return confinedBody(head, profile, plan, slice, unit, mutants, priorSummary, `Return {lens: "${lenses.join('+')}", findings[] (each with its lens in source), questions[] (each with the lens of the finding that depends on it in source)}.`)
}

// The part of a confined prompt after its lens brief: the slice, the unit rule in the place of the slice's
// "never what you may READ" and of the CONTEXT EXPANSION, BLAST-RADIUS and WHERE-CHECKED instructions.
/**
 * @param {string} head @param {Profile} profile @param {Plan} plan @param {Slice} slice
 * @param {Confinement} unit @param {string} mutants @param {string} priorSummary @param {string} returns
 */
function confinedBody(head, profile, plan, slice, unit, mutants, priorSummary, returns) {
  return `${head}
Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()} -- ${lensPathspec(slice, profile)}\`.
YOUR SLICE: \`${slice.key}\` — ${slice.files.length} changed file(s) of a larger diff. Sibling lenses hold the other ${unit.kind.noun}s, and overlapping findings are de-duplicated downstream.
EFFICIENCY: pull your slice's diff ONCE, in one command.
${unitRuleBlock(unit)}
${reReviewBlock()}
${lensPlanLines(plan)}

CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${mutants}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

${returns}

Observability: the review workflow records this run — do NOT write your own record.`
}
return { scoutPrompt, lensPrompt, multiLensPrompt, extraLensPrompt, lensDiffRange }
}
