// The prompts of the review engine's crateScope mode (src/review.js): the crate rule a confined lens works
// under, the contract lens, the live coordinator, the seam pass and the crate-roots probe. The channel is a
// directory under the run directory, the one place lens agents and the coordinator both reach: agents of one
// wave share the filesystem and no message channel exists between them (realm @nick/craft, node #325).
import { shq } from './run-logging.mjs'

// One Bash call stays under the tool's 120 s default timeout: a 100 s wait, run with an explicit timeout.
const WAIT_LOOP_SECONDS = 100
const BASH_TIMEOUT = 'Bash timeout 120000'

// The crate rule that replaces, in a confined lens, the slice line "bounds what you judge, never what you
// read" and the CONTEXT EXPANSION, BLAST-RADIUS and WHERE-CHECKED instructions — all of which send the lens
// into other crates (realm @nick/craft, node #316). `channel` is '' when the run has no directory to hold
// one, and `tag` '' on a dispatch no coordinator listens to (a resurrection): both leave deferred questions only.
// A batch of several crates (realm @nick/craft, #355) is one boundary: bodies may be read in any of its crates.
/** @param {{ root: string, roots?: string[], channel: string, tag: string }} crate */
export function crateRuleBlock({ root, roots, channel, tag }) {
  const all = roots?.length ? roots : [root]
  const r = all.map(x => `\`${x === '.' ? '.' : `${x}/`}\``).join(', ')
  const ch = channel && tag ? shq(channel) : ''
  // The round's coordinator leaves a `gone-r<round>` marker when it stops, so a lens can tell it gone from slow.
  const gone = `${ch}/gone-r${/r(\d+)$/.exec(tag)?.[1] ?? '0'}`
  const blocking = ch
    ? `BLOCKING QUESTION — only when you cannot go on without the answer: in one Bash call run \`id=${tag}-$(date +%s%N); mkdir -p ${ch} && printf '%s' '<json>' > ${ch}/.q-$id.tmp && mv ${ch}/.q-$id.tmp ${ch}/q-$id.json; echo $id\` with <json> = {"from":"${tag}","crate","symbol","path","ask","findingTitle","findingFile"} (a fresh id for every question, never reused). Then wait in ONE Bash call (${BASH_TIMEOUT}): \`for i in $(seq ${WAIT_LOOP_SECONDS / 5}); do [ -e ${ch}/a-<id>.json ] && break; [ -e ${gone} ] && break; sleep 5; done; cat ${ch}/a-<id>.json 2>/dev/null || { [ -e ${gone} ] && echo NO-COORDINATOR || echo NO-ANSWER; }\`. NO-ANSWER → you may wait once more the same way; still none → treat it as unknown, answer "NO-ANSWER". NO-COORDINATOR → the coordinator has left: do not wait again, treat it as unknown, answer "NO-COORDINATOR".\n`
    : ''
  return `CRATE SCOPE — this OVERRIDES every other instruction about context in this prompt AND in your agent definition (its "expand context", "trace its callers, impls" and "blast-radius over callers" steps do not apply here): you judge and READ ${all.length > 1 ? `the ${all.length} crates rooted at ${r} (one batch)` : `the crate rooted at ${r}`}.
- Read code BODIES (Read, cat/sed/head, grep with context lines) ONLY under ${r}. Of any other crate — in this repository or a dependency — use only pub signatures and doc comments: \`git grep -n -E '^\\s*(pub|///)' -- <its path>\` with no -A/-B/-C context, never a body.
- Another crate's behaviour matters to a finding (what it returns, what it guarantees, who else writes this state)? Do not read it — ASK.
${blocking}- DEFERRED QUESTION — anything else: list it in \`questions\` and go on. List EVERY question you asked in \`questions\` (blocking: true if you wrote a q-file, answered: true if its answer came), naming the finding that depends on it in findingTitle and findingFile; a finding that rests on an unanswered question says so in \`why\`.
- whereChecked: premises inside ${r} pinned to a file:line you opened; a premise about another crate is a question, not a whereChecked entry.
- blastRadius: the pub items of this crate the change touches; consumers in other crates are the seam pass's, not yours.
- A defect located in another crate is not yours; do not report it.${ch ? `\nLAST STEP, always, findings or not: \`touch ${ch}/done-${tag}\`.` : ''}`
}

// The contract lens reads the contract and the seam, never a body (realm @nick/craft, node #327): the same
// override of the agent's context steps a confined lens gets, with the reading rule of a contract.
/** @param {{ root: string, lang: string, range: string, priorSummary: string }} c */
export function contractPrompt({ root, lang, range, priorSummary }) {
  const r = shq(root)
  return `CRATE SCOPE — this OVERRIDES every other instruction about context in this prompt AND in your agent definition (its "expand context", "trace its callers, impls" and "blast-radius over callers" steps do not apply here): you judge the public contract of the crate at ${r}, and you never read a function body — of this crate or any other.
- Its public surface: \`git grep -n -E '^\\s*(pub|///|#\\[)' -- ${r}\` and its Cargo.toml, with no -A/-B/-C context; a pub item's whole signature (a multi-line fn, a struct's fields, an enum's variants) by \`sed -n\` over just those lines, never past its opening brace into a body.
- How other crates use it: the call-site lines \`git grep -n -w <item> -- .${root === '.' ? '' : ` ':!${root}'`}\` prints, with no -A/-B/-C context, never the file around them.
You are the **contract** lens of a ${lang} review: judge the PUBLIC CONTRACT of the crate at ${r} as a contract — is it sane at all? Read only its public surface — pub items, error types and variants, trait bounds, Cargo features, re-exports, docs; signatures, never a function body — and how other crates use it (their call sites). What changed: \`git diff ${range} -- ${r}\`.
Find: misuse the types allow (an invariant kept by convention, not by type; a constructor admitting invalid state); errors that do not tell the caller what to do; a leaked internal type or dependency; parts of the API contradicting each other; a contract wider or narrower than what other crates actually use.
SEVERITY: Medium or above ONLY with a concrete misuse path (the calls, in order, that compile and go wrong). Style (naming, missing docs) goes into ONE Low for the crate. Not idiom compliance — that is api-idioms.
Each finding at the pub item's file:line, \`whereChecked\` the call site or doc you read, \`ruleId\` "".
ALREADY-FOUND (do not repeat):
${priorSummary}

Return {lens: "contract", findings[]}. Observability: the workflow records this run — do NOT write your own record.`
}

// The coordinator lives as long as its round — every lens done, or released by the round's stop file — and
// never past `capMinutes`, the Lenses phase deadline its own dispatch runs under.
/** @param {{ lang: string, channel: string, round: number, expected: number, capMinutes: number }} c */
export function coordinatorPrompt({ lang, channel, round, expected, capMinutes }) {
  const ch = shq(channel)
  return `You are the cross-crate COORDINATOR of a ${lang} review, round ${round}. Lens agents, each confined to one crate, write questions about OTHER crates into ${ch} as q-<id>.json {from, crate, symbol, path, ask, findingTitle, findingFile}. You read only that channel and the code a question addresses.
Poll in calls of at most ${WAIT_LOOP_SECONDS} s (${BASH_TIMEOUT}): \`mkdir -p ${ch} && cd ${ch} && timeout ${WAIT_LOOP_SECONDS} sh -c 'while :; do for q in q-*.json; do [ -e "$q" ] && [ ! -e "a-\${q#q-}" ] && { echo "$q"; exit 0; }; done; [ $(ls done-*r${round} 2>/dev/null | wc -l) -ge ${expected} ] && { echo ALLDONE; exit 0; }; [ -e stop-r${round} ] && { echo STOP; exit 0; }; sleep 5; done'; echo "exit $?"\`. "exit 124" means nothing arrived yet — run it again.
For each q-file it prints: answer it by reading ONLY the named symbol/path in the named crate (grep the symbol — never read a whole crate), then write a-<same id>.json {"answer": "...", "evidence": "file:line"} to .a-<id>.tmp and mv it into place. Poll again. Stop ONLY on ALLDONE or STOP — a quiet channel is no reason to leave while lenses still run — or after ${capMinutes} minutes in all. Whenever you stop, first run \`touch ${ch}/gone-r${round}\`, so a lens still waiting learns you left. Change nothing outside ${ch}.
Return {answered, unanswered, notes}.`
}

/** @param {{ lang: string, crates: string[], range: string, open: unknown[] }} c */
export function seamPrompt({ lang, crates, range, open }) {
  return `You are the SEAM coordinator of a ${lang} review. The lenses were each confined to one crate, so the integration between crates is yours, judged strictly. Touched crates: ${crates.map(c => `\`${c}\``).join(', ')}. Diff: \`git diff ${range}\`.
1. Every changed pub item (fn, type, variant, trait, const, re-export, Cargo feature): grep its call sites in OTHER crates; does every caller still match its signature, semantics, error variants and invariants?
2. Wire files the changed crates produce or consume (CRD, Helm chart and values, migrations, OpenAPI/proto, JSON schemas): do the code and the file agree, both ways?
3. Questions the lenses left open — answer each from the code it addresses: ${JSON.stringify(open)}
For each finding a question names, give a disposition carrying its lens, findingFile and findingTitle exactly as the question has them: confirm, drop (its premise is false) or convert (report a seam finding in its place).
Report seam defects as findings at the file:line that is wrong, \`whereChecked\` the other side, \`ruleId\` "". Medium or above only with a concrete path. Return {findings, dispositions, answered}.`
}

// The Cargo packages, with what the batching needs of each (realm @nick/craft, #355): one line per package —
// `@@ <dir> <.rs lines> <pub lines> <package name> <dependency names>...` — and the diff's numstat. The awk
// reads [package] name, every [*dependencies] key (a `package = ` rename wins) and [dependencies.<name>]
// tables, never [workspace.*]. Lines count the .rs files git lists under the directory, a nested package's
// included. The awk is written without backslashes and `${`, so it survives the template literal as typed;
// its rules are joined by `; `, the terminator POSIX awk needs between rules on one line.
const PACKAGE_AWK = `/^[[:space:]]*[[]/ { h=$0; gsub(/[[:space:]]/,"",h); sec=h; dk=""; if (h ~ /^[[]workspace/) { sec="ws" } else if (h ~ /dependencies[.]/) { dk=h; sub(/^.*dependencies[.]/,"",dk); sub(/[]].*$/,"",dk); dep[dk]=dk; sec="dep-table" }; next }
sec=="[package]" && /^[[:space:]]*name[[:space:]]*=/ { v=$0; sub(/^[^"]*"/,"",v); sub(/".*$/,"",v); name=v; next }
sec=="dep-table" && /^[[:space:]]*package[[:space:]]*=/ { v=$0; sub(/^[^"]*"/,"",v); sub(/".*$/,"",v); dep[dk]=v; next }
sec ~ /dependencies[]]$/ && /^[[:space:]]*[A-Za-z0-9_-]/ { k=$0; sub(/^[[:space:]]*/,"",k); sub(/[^A-Za-z0-9_-].*$/,"",k); p=k; if ($0 ~ /package[[:space:]]*=[[:space:]]*"/) { p=$0; sub(/^.*package[[:space:]]*=[[:space:]]*"/,"",p); sub(/".*$/,"",p) }; dep[k]=p; next }
END { line="@@ " d " " c " " s " " name; for (k in dep) line=line " " dep[k]; print line }`

/** @param {string} range  the lens diff range, as lensDiffRange spells it */
export function cratesPrompt(range) {
  const packages = `git ls-files 'Cargo.toml' '*/Cargo.toml' | while read -r f; do grep -q '^\\[package\\]' "$f" || continue; d=$(dirname "$f"); c=$(git ls-files -- "$d" | grep '[.]rs$' | tr '\\n' '\\0' | xargs -0 -r cat | wc -l); s=$(git grep -h -E '^[[:space:]]*pub[[:space:](]' -- "$d" | wc -l); awk -v d="$d" -v c="$c" -v s="$s" '${PACKAGE_AWK.replace(/\n/g, '; ')}' "$f"; done`
  return `List the Cargo packages of this repository and the diff's line counts. Change nothing. Run each command below ONCE, exactly as written, in one Bash call each.
1. Packages: \`${packages}\`
   Return every line it printed, verbatim and in order, in packages, and the second field of each line (the directory; "." for the root) in roots.
2. Changed lines: \`git diff --numstat --no-renames ${range}\`
   Return every line it printed, verbatim, in numstat.`
}

/** @param {string} channel @param {number} round */
export function stopPrompt(channel, round) {
  const ch = shq(channel)
  return `Run \`mkdir -p ${ch} && touch ${ch}/stop-r${round} && ls ${ch}/stop-r${round}\` and answer written: true only when ls printed the file.`
}
