// The prompts of the review engine's unitScope mode (src/review.js): the unit rule a confined lens works
// under, the contract lens, the live coordinator and the seam pass, each in the words of the profile's unit
// discovery (`kind`, lib/unit-graph.mjs; Rust's in lib/rust-units.mjs). The channel is a directory under
// the run directory, the one place lens agents and the coordinator both reach: agents of one
// wave share the filesystem and no message channel exists between them (realm @nick/craft, node #325).
import { shq } from './run-logging.mjs'
import { repoRulesLine } from './repo-rules.mjs'
import { render } from './content.mjs'
import scopeHeadTpl from '../content/prompts/unit-scope-head.md'
import unitRuleTpl from '../content/prompts/unit-rule.md'
import contractTpl from '../content/prompts/lens-contract.md'
import seamTpl from '../content/prompts/seam.md'

/** @typedef {import('./unit-graph.mjs').UnitDiscovery} UnitDiscovery */

// One Bash call stays under the tool's 120 s default timeout: a 100 s wait, run with an explicit timeout.
const WAIT_LOOP_SECONDS = 100
const BASH_TIMEOUT = 'Bash timeout 120000'

// The head of a confined prompt: it overrides the agent's own context steps, which send a lens past its unit —
// all but the repository's rule files, which a lens greps wherever they sit (realm @nick/craft, #406, #410).
/** @param {string} noun */
const scopeHead = noun => render(scopeHeadTpl, { upperNoun: noun.toUpperCase() })

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
  return render(unitRuleTpl, {
    scopeHead: scopeHead(n), noun: n, roots: r, signatures: kind.signatures, blocking,
    judged: all.length > 1 ? `the ${all.length} ${n}s rooted at ${r} (one batch)` : `the ${n} rooted at ${r}`,
    done: ch ? `\nLAST STEP, always, findings or not: \`touch ${ch}/done-${tag}\`.` : '',
  })
}

// The contract lens reads the contract and the seam, never a body (realm @nick/craft, node #327): the same
// override of the agent's context steps a confined lens gets, with the reading rule of a contract.
/** @param {{ root: string, lang: string, kind: UnitDiscovery, range: string, priorSummary: string, repoRules?: string[] }} c */
export function contractPrompt({ root, lang, kind, range, priorSummary, repoRules = [] }) {
  const r = shq(root)
  const n = kind.noun
  return render(contractTpl, {
    scopeHead: scopeHead(n), noun: n, root: r, lang, range, priorSummary, surface: kind.surface(r), publicItems: kind.publicItems,
    exclude: root === '.' ? '' : ` ':!${root}'`, repoRules: repoRulesLine(repoRules),
  })
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
  return render(seamTpl, {
    lang, noun: n, units: units.map(c => `\`${c}\``).join(', '), range, changedItems: kind.changedItems,
    open: JSON.stringify(open), repoRules: repoRulesLine(repoRules),
  })
}

/** @param {string} channel @param {number} round */
export function stopPrompt(channel, round) {
  const ch = shq(channel)
  return `Run \`mkdir -p ${ch} && touch ${ch}/stop-r${round} && ls ${ch}/stop-r${round}\` and answer written: true only when ls printed the file.`
}
