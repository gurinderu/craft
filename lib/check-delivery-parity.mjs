// Every review agent ships TWICE — once under `agents/` for Claude Code, once under
// `opencode/agents/` — and the two bodies are maintained by hand. Until this checker, nothing
// compared them: each existing gate judges one file's SHAPE in isolation, and shape is exactly what
// stays valid while meaning drifts apart.
//
// That is not a hypothetical. A fix shipped for the Claude Code delivery did not reach the port and
// survived there verbatim — an unrun Miri reported `Clean` — and no green CI showed it, because
// nothing in CI was looking at the pair.
//
// WHAT IS COMPARED, and why not more. Not the bodies: the two contracts differ on purpose (root
// agents carry `name` + a pinned `model` + `tools` as a list; opencode agents carry none of those
// and add `mode: subagent`). Not the counts either: "INCOMPLETE appears 7 times here and 5 there"
// is noise a reviewer cannot act on. What is compared is the SET OF VERDICTS EACH SIDE CAN REPORT.
// A verdict the root agent can reach and its port cannot is the exact failure above: a whole outcome
// missing from one delivery, which is meaning, not formatting.
//
// What is measured is the BODY, with the leading YAML frontmatter block stripped first. This is not
// a stylistic choice — it is load-bearing, because an agent's `description:` line names the outcomes
// the agent reports, so a `description:` sitting above a body that LOST an outcome can still make
// the unstripped file read as fully covered: the frontmatter stands in for the very thing that broke.
// Verified against the real opencode/agents/rust-reviewer.md: replace every body occurrence of
// INCOMPLETE with APPROVE and the unstripped file still reads as fully covered — by the description,
// not the body — while the stripped body correctly shows the loss. See `stripFrontmatter` below for
// how the strip is performed, and re-run the one-liner there to see the current body-vs-frontmatter
// table for every agent file, including whether a given file's own `description:` line covers what
// its body does. The `description:` lines are therefore unmeasured by this gate; whether the two
// descriptions agree with each other is a separate, open parity question.
//
// The vocabulary is not remembered — a tripwire in check-delivery-parity.test.mjs runs every word
// through one of the parsers that actually reads these verdicts (`worstVerdict` in
// lib/run-record.mjs) and asserts it lands on the outcome claimed here. A list held by memory
// drifts from the engine the moment either moves, which is the defect class this file exists
// inside.
//
// CEILING, stated plainly: `outcomesReported` matches any occurrence of a rubric word anywhere in
// the body, including inside ordinary prose — `outcomesReported('Never Block on style nits; do not
// report Concerns for formatting.')` returns `bad` and `concern` though neither is a verdict path.
// So a port that drops an actual outcome-reporting branch while leaving the word mentioned in
// passing prose (a caveat, a comparison, a removed example) still reads as covering that outcome.
// This gate proves the word is reachable somewhere in the text, not that the body still contains a
// working path to report it. Accepted: catching that would need parsing the rubric's control flow,
// which this checker does not attempt.
//
// A second, unstated limit: OUTCOMES is a closed four-bucket set. The tripwire in
// check-delivery-parity.test.mjs only proves the TABLE→ENGINE direction, and only against ONE of the
// two engines that read these verdicts — every word claimed here is confirmed against `worstVerdict`
// in lib/run-record.mjs, but the Claude Code side is also read by a second, independent engine,
// `RANK` in opencode/plugin/run-record.mjs, and the tripwire's words never run through it. Nothing
// proves the ENGINE→TABLE direction either: a fifth verdict added to either engine would fall
// outside this gate entirely, with every test here still green. Concretely, `worstVerdict` also
// matches `Pass` (in `Approve|Healthy|Clean|Pass`), a word this OUTCOMES table does not carry at
// all — one instance of the gap, not a reason to add `Pass` here. Accepted, not implemented.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The OUTCOMES an agent can reach, in its RUBRIC's words. The uppercase machine tokens are
// deliberately absent from this table, and that is the whole design.
//
// Each delivery expresses a verdict differently, and the difference is CONTRACTUAL, not a defect: an
// OpenCode agent must additionally end with a machine-read `VERDICT: X` line, because its dispatcher
// parses that line; a Claude Code agent reports in the rubric's words and emits a JSON record.
// Comparing the words as written flagged every pair — measuring the transport and calling it the
// meaning, which is the false-positive shape this repository keeps producing. Worse, the machine
// line ENUMERATES all four tokens, so a port that lost an outcome entirely still contains the word:
// counting `INCOMPLETE` would have been blind to exactly the defect this checker exists for.
//
// So `incomplete` is keyed on the rubric phrase `INCOMPLETE (not run)`, which names the outcome,
// rather than on the bare token, which merely enumerates it.
export const OUTCOMES = {
  ok: ['Approve', 'Clean', 'Healthy'],
  concern: ['Warning', 'Concerns'],
  bad: ['Block', 'At-risk', 'UB-found'],
  incomplete: ['INCOMPLETE (not run)'],
}

// Strips a leading YAML frontmatter block (`---` … `---`) so the gate measures the BODY, not the
// file. The property this guards against: an agent's `description:` line names the outcomes the
// agent reports, so a `description:` can stand in for a body that lost an outcome — the frontmatter
// keeps covering for a defect the body no longer has a path to. Verified on the real
// opencode/agents/rust-reviewer.md: replace every body occurrence of INCOMPLETE with APPROVE and the
// unstripped file still reads as fully covered, because the description above it already carries the
// words on its own.
//
// Counts here would rot the moment either delivery's agents change, which is exactly how this file
// twice recorded a false claim about how many files were "full" — so this file states no per-file
// counts. To see the CURRENT body-vs-frontmatter table for every agent file, re-run (verified
// working from the repo root):
//
//   node -e 'import("./lib/check-delivery-parity.mjs").then(({OUTCOMES,outcomesReported})=>{const fs=require("fs");const setFor=t=>new Set(Object.entries(OUTCOMES).filter(([,ws])=>ws.some(w=>new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?![\\w-])`).test(t))).map(([o])=>o));const all=Object.keys(OUTCOMES);const fmt=s=>all.every(o=>s.has(o))?"FULL":([...s].sort().join(",")||"none");for (const f of [...fs.readdirSync("agents").filter(x=>x.endsWith(".md")).map(x=>"agents/"+x),...fs.readdirSync("opencode/agents").filter(x=>x.endsWith(".md")).map(x=>"opencode/agents/"+x)]) {const text=fs.readFileSync(f,"utf8");const m=/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);console.log(f.padEnd(46),"body:",fmt(outcomesReported(text)).padEnd(20),"fm:",fmt(setFor(m?m[0]:"")))}})'
//
// The `description:` lines themselves are unmeasured by this gate; whether the two descriptions
// agree with each other is a separate, open parity question, not addressed here.
//
// One property this measurement does confirm: neither `rust-miri` body nor its frontmatter reports
// `concern` — miri has no Warning path, so that is correct for this agent, not a gap.
function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)
  return m ? text.slice(m[0].length) : text
}

// Which outcomes a body can report. Case-SENSITIVE, so the rubric word is not confused with the
// uppercase token that transports it. Whole-word, with the boundary spelled rather than `\b` —
// `At-risk` and `UB-found` carry a hyphen, and `\b` matches between `k` and `-`, which would find
// `At-risk` inside `At-risky`.
export function outcomesReported(body) {
  const text = stripFrontmatter(String(body ?? ''))
  const found = new Set()
  for (const [outcome, words] of Object.entries(OUTCOMES)) {
    for (const w of words) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(text)) {
        found.add(outcome)
        break
      }
    }
  }
  return found
}

// Agents deliberately shipped for Claude Code only. An entry is a REASON, not a silence: the pair
// is missing on purpose and the file says why. And the exception is checked in both directions —
// once the port exists, the entry is stale and this fails, so the list cannot quietly outlive what
// it excused.
export const UNPAIRED_BY_DESIGN = {
  'nix-reviewer': 'the OpenCode delivery ships no Nix profile — there is no nix-review command to call it',
}

// `root` and `opencode` are Maps of agent name → body. `unpaired` defaults to the real
// UNPAIRED_BY_DESIGN allowlist; a caller may inject its own so a test about something else does
// not have to carry the whole real allowlist just to stay quiet under it (realm @nick/craft).
export function checkParity(root, opencode, unpaired = UNPAIRED_BY_DESIGN) {
  const problems = []

  // The staleness check on `unpaired`, in the direction the root-keyed loop below cannot
  // reach: that loop only visits names present in `root`, so an entry whose ROOT file was deleted
  // (present in neither map) is never visited and the excuse lingers for nothing. Iterating the
  // allowlist's own keys catches that: an excuse for a name that exists on neither side is dead
  // weight, not a real exception.
  for (const name of Object.keys(unpaired)) {
    if (!root.has(name) && !opencode.has(name)) {
      problems.push(
        `UNPAIRED_BY_DESIGN has an entry for "${name}", but it exists on neither side — drop the entry`,
      )
    }
  }

  for (const name of opencode.keys()) {
    if (!root.has(name)) {
      problems.push(`opencode/agents/${name}.md has no counterpart under agents/ — a port of nothing`)
    }
  }

  for (const [name, body] of root) {
    const excuse = unpaired[name]
    if (!opencode.has(name)) {
      if (!excuse) {
        problems.push(
          `agents/${name}.md ships only for Claude Code — add opencode/agents/${name}.md, ` +
            'or record it in UNPAIRED_BY_DESIGN with the reason',
        )
      }
      continue
    }
    if (excuse) {
      problems.push(
        `agents/${name}.md is listed in UNPAIRED_BY_DESIGN ("${excuse}") but opencode/agents/${name}.md now exists — drop the entry`,
      )
    }

    const here = outcomesReported(body)
    const there = outcomesReported(opencode.get(name))
    const onlyRoot = [...here].filter((t) => !there.has(t))
    const onlyPort = [...there].filter((t) => !here.has(t))
    if (onlyRoot.length) {
      problems.push(
        `${name}: agents/ can report ${onlyRoot.join(', ')} and opencode/agents/ cannot — ` +
          'an outcome reachable in one delivery and not the other',
      )
    }
    if (onlyPort.length) {
      problems.push(
        `${name}: opencode/agents/ can report ${onlyPort.join(', ')} and agents/ cannot — ` +
          'an outcome reachable in one delivery and not the other',
      )
    }
  }

  return problems
}

export function readAgents(dir) {
  const out = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    out.set(f.slice(0, -3), fs.readFileSync(path.join(dir, f), 'utf8'))
  }
  return out
}

// ── CLI mode ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const root = readAgents(path.join(rootDir, 'agents'))
  const opencode = readAgents(path.join(rootDir, 'opencode', 'agents'))

  if (root.size === 0) {
    // An empty read is the one way this checker passes without checking anything.
    console.error('FAIL  agents/ :: no agent files found — the checker would pass vacuously')
    process.exit(1)
  }

  const problems = checkParity(root, opencode)
  for (const p of problems) console.error('FAIL  delivery parity ::', p)
  const paired = [...root.keys()].filter((n) => opencode.has(n)).length
  console.log(`compared ${paired} agent pair(s) across ${root.size} Claude Code and ${opencode.size} OpenCode agents`)
  console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall clean')
  process.exit(problems.length ? 1 : 0)
}
