// The gate alone (`gateOnly`, lib/cli-review-steps.mjs): the `craft review gate` command and its answer. The binary
// runs the mechanical gate a review start runs — clippy and semgrep for Rust, nix flake check, statix and deadnix for
// Nix — over the whole change, with no run, no lens and no record (cli/crates/craft-review/src/gate/alone.rs), so a
// parent that reviews a workspace crate by crate with `gate=false` gates it once (rust-audit; realm @nick/craft, node
// #150). The answer is a `## Verdict` block in the form every reader of a review report parses
// (lib/rust-audit-verdict.mjs, verdictLine), a red gate in the review's own words, then the report's `## Gate` section.
import { shq } from './plugin-script.mjs'
import { absolutePath, commandOutput, isObject } from './cli-review-step.mjs'

// The gate's budget is 300 s (cli/crates/craft-review/src/gate.rs), past a Bash call's default two minutes.
const GATE_TIMEOUT = 'in one Bash call with a timeout of 420000 ms (it builds and lints the branch for the mechanical gate)'

/**
 * The command that runs the gate alone over `repo` ('' the session's checkout) against `base` ('' the binary's default).
 * @param {string} bin  as the commands spell it (lib/plugin-script.mjs, shellWord) @param {{ repo: string, base: string }} o @returns {string}
 */
export const gateShell = (bin, o) => `${bin} review gate --cwd ${o.repo ? shq(o.repo) : '.'}${o.base ? ` --base ${shq(o.base)}` : ''}`

/** The service step's instruction to run the gate alone. @param {string} bin @param {{ repo: string, base: string }} o @returns {string} */
export const gateCommand = (bin, o) => `Run exactly this one command, ${GATE_TIMEOUT}:\n\n${gateShell(bin, o)}`

/** @param {unknown} v @returns {string} */
const textOf = v => (typeof v === 'string' ? v : '')

/** The gate's tracks. @param {Record<string, unknown>} gate @returns {unknown[]} */
const tracksOf = gate => (Array.isArray(gate['tracks']) ? gate['tracks'] : [])

/** The profiles the gate ran for, joined. @param {Record<string, unknown>} gate @returns {string} */
function profiles(gate) {
  return tracksOf(gate).map(t => (isObject(t) ? textOf(t['profile']) : '')).filter(Boolean).join(', ')
}

/**
 * Why a profile had nothing to gate (realm @nick/craft, node #487): Rust — no Cargo package holds the changed `.rs` files; Nix — no
 * `flake.nix`, its linters ran (or no `.nix` file is left to lint) — read off the provenance the CLI writes, held to
 * `content/parity/gate-provenance.json`, which this module's test reads.
 * @param {unknown} t @returns {string}
 */
function nothingWhy(t) {
  const profile = isObject(t) ? textOf(t['profile']) : ''
  if (profile === 'rust') return 'rust: no Cargo package holds the changed .rs files'
  if (profile !== 'nix') return profile
  const linted = isObject(t) && textOf(t['provenance']).includes('`deadnix -o json`: local')
  return linted ? 'nix: no flake.nix, and statix and deadnix ran' : 'nix: no flake.nix, and no .nix file left to lint'
}

/**
 * The verdict line for how the gate came out: red as the binary words it (the review's own `⛔ Block — mechanical gate
 * is red (…)`), green, not established (a Warning, the binary's reason with the CI it saw), or nothing to gate (no gated file, or
 * each gated profile with nothing to establish).
 * @param {Record<string, unknown>} v @returns {string}
 */
function gateLine(v) {
  const gate = isObject(v['gate']) ? v['gate'] : {}
  const ran = profiles(gate)
  switch (v['outcome']) {
    case 'fail': return textOf(v['line']) || `⛔ Block — mechanical gate is red (${ran}).`
    case 'pass': return `✅ Approve — mechanical gate is green (${ran}).`
    // Not established is no pass and no failure: at most Warning, with the CI it saw (realm @nick/craft, node #487).
    case 'unknown': return `⚠️ Warning — ${textOf(v['line']) || `the gate was not established locally (${ran})`}: its signal is unknown, neither a failure nor a pass; the Gate section says why.`
    // A profile with nothing to gate is no unknown signal and caps nothing (realm @nick/craft, node #487).
    default: return ran
      ? `✅ Approve — the mechanical gate had nothing to establish (${tracksOf(gate).map(nothingWhy).filter(Boolean).join('; ')}).`
      : '✅ Approve — no Rust or Nix file in the change, so the mechanical gate had nothing to run on.'
  }
}

/**
 * The gate's answer from what the command printed, or why it printed nothing usable (the caller then answers
 * INCOMPLETE with `error`).
 * @param {unknown} got @returns {{ answer: string } | { error: string, harness?: string }}
 */
export function gateAnswer(got) {
  const out = commandOutput(got)
  if ('error' in out) return out
  /** @type {unknown} */
  let v
  try { v = JSON.parse(out.stdout) } catch { return { error: `the gate printed no JSON: ${out.stdout.slice(0, 200)}` } }
  if (!isObject(v) || !['fail', 'pass', 'unknown', 'none'].includes(String(v['outcome']))) return { error: 'the gate printed no outcome' }
  const section = textOf(v['section']).trim() || '## Gate\n\nNothing to gate: no Rust or Nix file in the change.'
  const dir = absolutePath(v['dir'])
  const kept = dir ? ` Its result and seeds are kept in ${dir}: a review of this change takes them with gateFrom=${dir}.` : ''
  return { answer: `## Verdict\n\n${gateLine(v)}\n\nThe mechanical gate alone over ${textOf(v['base']) || 'the default base'}..${textOf(v['head']).slice(0, 12) || 'HEAD'}: no lens ran and no run record was filed.${kept}\n\n${section}` }
}
