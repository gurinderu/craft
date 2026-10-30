// The prompts of the review engine's unitScope mode (src/review.js): the unit rule a confined lens works
// under, the contract lens, the live coordinator and the seam pass, each in the words of the profile's unit
// discovery (`kind`, lib/unit-graph.mjs; Rust's in lib/rust-units.mjs). The channel is a directory under
// the run directory, the one place lens agents and the coordinator both reach: agents of one
// wave share the filesystem and no message channel exists between them (realm @nick/craft, node #325).
import { shq } from './run-logging.mjs'
import { repoRulesLine } from './repo-rules.mjs'

/** @typedef {import('./unit-graph.mjs').UnitDiscovery} UnitDiscovery */

// One Bash call stays under the tool's 120 s default timeout: a 100 s wait, run with an explicit timeout.
const WAIT_LOOP_SECONDS = 100
const BASH_TIMEOUT = 'Bash timeout 120000'

// The head of a confined prompt: it overrides the agent's own context steps, which send a lens past its unit.
/** @param {string} noun */
const scopeHead = noun => `${noun.toUpperCase()} SCOPE — this OVERRIDES every other instruction about context in this prompt AND in your agent definition (its "expand context", "trace its callers, impls" and "blast-radius over callers" steps do not apply here): `

// The unit rule that replaces, in a confined lens, the slice line "bounds what you judge, never what you
// read" and the CONTEXT EXPANSION, BLAST-RADIUS and WHERE-CHECKED instructions — all of which send the lens
// into other units (realm @nick/craft, node #316). `channel` is '' when the run has no directory to hold
// one, and `tag` '' on a dispatch no coordinator listens to (a resurrection): both leave deferred questions only.
// A batch of several units (realm @nick/craft, #355) is one boundary: bodies may be read in any of its units.
/** @param {{ root: string, roots?: string[], channel: string, tag: string, kind: UnitDiscovery }} unit */
export function unitRuleBlock({ root, roots, channel, tag, kind }) {
  const n = kind.noun
  const all = roots?.length ? roots : [root]
  const r = all.map(x => `\`${x === '.' ? '.' : `${x}/`}\``).join(', ')
  const ch = channel && tag ? shq(channel) : ''
  // The round's coordinator leaves a `gone-r<round>` marker when it stops, so a lens can tell it gone from slow.
  const gone = `${ch}/gone-r${/r(\d+)$/.exec(tag)?.[1] ?? '0'}`
  const blocking = ch
    ? `BLOCKING QUESTION — only when you cannot go on without the answer: in one Bash call run \`id=${tag}-$(date +%s%N); mkdir -p ${ch} && printf '%s' '<json>' > ${ch}/.q-$id.tmp && mv ${ch}/.q-$id.tmp ${ch}/q-$id.json; echo $id\` with <json> = {"from":"${tag}","unit","symbol","path","ask","findingTitle","findingFile"} (a fresh id for every question, never reused). Then wait in ONE Bash call (${BASH_TIMEOUT}): \`for i in $(seq ${WAIT_LOOP_SECONDS / 5}); do [ -e ${ch}/a-<id>.json ] && break; [ -e ${gone} ] && break; sleep 5; done; cat ${ch}/a-<id>.json 2>/dev/null || { [ -e ${gone} ] && echo NO-COORDINATOR || echo NO-ANSWER; }\`. NO-ANSWER → you may wait once more the same way; still none → treat it as unknown, answer "NO-ANSWER". NO-COORDINATOR → the coordinator has left: do not wait again, treat it as unknown, answer "NO-COORDINATOR".\n`
    : ''
  return `${scopeHead(n)}you judge and READ ${all.length > 1 ? `the ${all.length} ${n}s rooted at ${r} (one batch)` : `the ${n} rooted at ${r}`}.
- Read code BODIES (Read, cat/sed/head, grep with context lines) ONLY under ${r}. Of any other ${n} — in this repository or a dependency — use only ${kind.signatures} with no -A/-B/-C context, never a body.
- Another ${n}'s behaviour matters to a finding (what it returns, what it guarantees, who else writes this state)? Do not read it — ASK.
${blocking}- DEFERRED QUESTION — anything else: list it in \`questions\` and go on. List EVERY question you asked in \`questions\` (blocking: true if you wrote a q-file, answered: true if its answer came), naming the finding that depends on it in findingTitle and findingFile; a finding that rests on an unanswered question says so in \`why\`.
- whereChecked: premises inside ${r} pinned to a file:line you opened; a premise about another ${n} is a question, not a whereChecked entry.
- blastRadius: the public items of this ${n} the change touches; consumers in other ${n}s are the seam pass's, not yours.
- A defect located in another ${n} is not yours; do not report it.${ch ? `\nLAST STEP, always, findings or not: \`touch ${ch}/done-${tag}\`.` : ''}`
}

// The contract lens reads the contract and the seam, never a body (realm @nick/craft, node #327): the same
// override of the agent's context steps a confined lens gets, with the reading rule of a contract.
/** @param {{ root: string, lang: string, kind: UnitDiscovery, range: string, priorSummary: string, repoRules?: string[] }} c */
export function contractPrompt({ root, lang, kind, range, priorSummary, repoRules = [] }) {
  const r = shq(root)
  const n = kind.noun
  return `${scopeHead(n)}you judge the public contract of the ${n} at ${r}, and you never read a function body — of this ${n} or any other.
- Its public surface: ${kind.surface(r)}.
- How other ${n}s use it: the call-site lines \`git grep -n -w <item> -- .${root === '.' ? '' : ` ':!${root}'`}\` prints, with no -A/-B/-C context, never the file around them.
You are the **contract** lens of a ${lang} review: judge the PUBLIC CONTRACT of the ${n} at ${r} as a contract — is it sane at all? Read only its public surface — ${kind.publicItems}; signatures, never a function body — and how other ${n}s use it (their call sites). What changed: \`git diff ${range} -- ${r}\`.
Find: misuse the types allow (an invariant kept by convention, not by type; a constructor admitting invalid state); errors that do not tell the caller what to do; a leaked internal type or dependency; parts of the API contradicting each other; a contract wider or narrower than what other ${n}s actually use.
SEVERITY: Medium or above ONLY with a concrete misuse path (the calls, in order, that compile and go wrong). Style (naming, missing docs) goes into ONE Low for the ${n}. Not idiom compliance — that is api-idioms.
Each finding at the public item's file:line, \`whereChecked\` the call site or doc you read, \`ruleId\` "".
${repoRulesLine(repoRules)}
ALREADY-FOUND (do not repeat):
${priorSummary}

Return {lens: "contract", findings[]}. Observability: the workflow records this run — do NOT write your own record.`
}

// The coordinator lives as long as its round — every lens done, or released by the round's stop file — and
// never past `capMinutes`, the Lenses phase deadline its own dispatch runs under.
/** @param {{ lang: string, noun: string, channel: string, round: number, expected: number, capMinutes: number }} c */
export function coordinatorPrompt({ lang, noun: n, channel, round, expected, capMinutes }) {
  const ch = shq(channel)
  return `You are the cross-${n} COORDINATOR of a ${lang} review, round ${round}. Lens agents, each confined to one ${n}, write questions about OTHER ${n}s into ${ch} as q-<id>.json {from, unit, symbol, path, ask, findingTitle, findingFile}. You read only that channel and the code a question addresses.
Poll in calls of at most ${WAIT_LOOP_SECONDS} s (${BASH_TIMEOUT}): \`mkdir -p ${ch} && cd ${ch} && timeout ${WAIT_LOOP_SECONDS} sh -c 'while :; do for q in q-*.json; do [ -e "$q" ] && [ ! -e "a-\${q#q-}" ] && { echo "$q"; exit 0; }; done; [ $(ls done-*r${round} 2>/dev/null | wc -l) -ge ${expected} ] && { echo ALLDONE; exit 0; }; [ -e stop-r${round} ] && { echo STOP; exit 0; }; sleep 5; done'; echo "exit $?"\`. "exit 124" means nothing arrived yet — run it again.
For each q-file it prints: answer it by reading ONLY the named symbol/path in the named ${n} (grep the symbol — never read a whole ${n}), then write a-<same id>.json {"answer": "...", "evidence": "file:line"} to .a-<id>.tmp and mv it into place. Poll again. Stop ONLY on ALLDONE or STOP — a quiet channel is no reason to leave while lenses still run — or after ${capMinutes} minutes in all. Whenever you stop, first run \`touch ${ch}/gone-r${round}\`, so a lens still waiting learns you left. Change nothing outside ${ch}.
Return {answered, unanswered, notes}.`
}

/** @param {{ lang: string, kind: UnitDiscovery, units: string[], range: string, open: unknown[], repoRules?: string[] }} c */
export function seamPrompt({ lang, kind, units, range, open, repoRules = [] }) {
  const n = kind.noun
  return `You are the SEAM coordinator of a ${lang} review. The lenses were each confined to one ${n}, so the integration between ${n}s is yours, judged strictly. Touched ${n}s: ${units.map(c => `\`${c}\``).join(', ')}. Diff: \`git diff ${range}\`.
1. Every changed ${kind.changedItems}: grep its call sites in OTHER ${n}s; does every caller still match its signature, semantics, error variants and invariants?
2. Wire files the changed ${n}s produce or consume (CRD, Helm chart and values, migrations, OpenAPI/proto, JSON schemas): do the code and the file agree, both ways?
3. Questions the lenses left open — answer each from the code it addresses: ${JSON.stringify(open)}
For each finding a question names, give a disposition carrying its lens, findingFile and findingTitle exactly as the question has them: confirm, drop (its premise is false) or convert (report a seam finding in its place).
Report seam defects as findings at the file:line that is wrong, \`whereChecked\` the other side, \`ruleId\` "". Medium or above only with a concrete path.
${repoRulesLine(repoRules)}
Return {findings, dispositions, answered}.`
}

/** @param {string} channel @param {number} round */
export function stopPrompt(channel, round) {
  const ch = shq(channel)
  return `Run \`mkdir -p ${ch} && touch ${ch}/stop-r${round} && ls ${ch}/stop-r${round}\` and answer written: true only when ls printed the file.`
}
