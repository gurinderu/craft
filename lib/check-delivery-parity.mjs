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
// What is measured is the BODY, with the leading YAML frontmatter block stripped first — the
// frontmatter's `description:` line alone can carry every outcome word, which made the gate pass
// vacuously on a body gutted of its outcomes. The two `description:` lines are therefore now
// unmeasured by this gate; whether they agree with each other is a separate, open parity question.
//
// The vocabulary is not remembered — a tripwire in check-delivery-parity.test.mjs runs every word
// through the parser that actually reads these verdicts and asserts it lands on the outcome claimed
// here. A list held by memory drifts from the engine the moment either moves, which is the defect
// class this file exists inside.
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
// file. Without this, the `description:` line alone can satisfy every outcome — verified: the real
// opencode/agents/rust-reviewer.md still reads as fully covered even with all 7 body occurrences of
// INCOMPLETE replaced by APPROVE, because the description line carries the words on its own. Three
// of the four pairs on this branch derived their whole outcome set from the description alone.
// NOTE: the `description:` lines themselves are now unmeasured by this gate — whether the two
// descriptions agree is its own, separate parity question, not addressed here.
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
