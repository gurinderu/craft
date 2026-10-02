// Syntax-checks the scripts in workflows/. They can't be `node --check`'d directly: each combines a
// top-level `export`, top-level `await`, and top-level `return` — a trio that is only legal inside
// the workflow sandbox's wrapper. We reproduce that wrapper (strip the single leading `export`, wrap
// the body in an async function) and let `new Function` compile-check it. Exits non-zero on any
// syntax error so CI fails loudly. This does NOT run the scripts — sandbox globals (agent, parallel,
// phase, budget, log, workflow, args) stay unresolved free identifiers, which is fine for a parse.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAll, unresolvedSiblings, findRegions, typedScopeProblems } from './inline-regions.mjs'
import { inlinedNameProblems } from './inlined-sandbox-names.mjs'
import { checkVersionStamps } from './workflow-version.mjs'
import { loadTypescript, runTsc, tscMissingMessage } from './run-tsc.mjs'
import { exitWith, invokedDirectly, scriptOutput } from './script-run.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @typedef {ReturnType<typeof scriptOutput>} Io */

/** @param {string} dir @param {string[]} files @param {Io} io @returns {number} failures */
function parseScripts(dir, files, io) {
  let bad = 0
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^export const meta/m, 'const meta')
    try {
      new Function(`async function __wf(){\n${src}\n}`)
      io.out('ok   ', f)
    } catch (e) {
      bad++
      io.err('FAIL ', f, '::', /** @type {Error} */ (e).message)
    }
  }
  io.out(`\n${files.length - bad}/${files.length} workflow scripts parse`)
  // `0/0 workflow scripts parse` used to exit 0: nothing was compiled, and the run was indistinguishable
  // from one where everything compiled. craft always ships workflow scripts, so an empty directory here
  // means the checker is pointed at the wrong place — a misconfiguration, reported as one.
  if (!files.length) {
    io.err('FAIL  workflows/ :: no .js scripts found — nothing was checked (this is a misconfiguration, not a pass)')
    bad++
  }
  return bad
}

// A workflow that files its own run record must stamp CRAFT_VERSION on it, and that stamp must
// agree with the plugin manifest. Two ways to lose this, and both used to be silent: the stamp
// drifts (every record from here on is labelled with a version that was never released), or the
// stamp is simply absent (records go back to being version-less). The old check `continue`d on
// absence, so a deleted line — or a new record-filing workflow that never got one — read exactly
// like a pass. Which workflows must carry it is derived from the source, not listed: see
// lib/workflow-version.mjs.
/** @param {string} root @param {string} dir @param {string[]} files @param {Io} io @returns {number} failures */
function versionStamps(root, dir, files, io) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  const stamps = checkVersionStamps(files.map(f => ({ name: f, src: fs.readFileSync(path.join(dir, f), 'utf8') })), manifest.version)
  for (const line of stamps.oks) io.out(`ok    ${line}`)
  for (const line of stamps.failures) io.err(`FAIL  ${line}`)
  return stamps.failures.length
}

// The sandbox cannot import, so shared helpers are pasted into the workflow scripts. Each pasted
// block is fenced (`// >>> craft-inline <source> <names…>`); regenerate it from the source and
// compare byte-for-byte, so a copy can never quietly drift from its original again. Lives here
// rather than in a sibling script because this file already IS the gate for workflows/*.js and is
// already wired into CI — a second entry point would just be another thing to forget to run.
// `--fix` regenerates the regions in place; without it the checker is read-only.
/** @param {string} dir @param {boolean} fix @param {Io} io @returns {number} failures */
function inlineDrift(dir, fix, io) {
  const inline = checkAll({ dir, fix })
  for (const m of inline.mismatches) {
    io.err(`FAIL  ${m.file}:${m.line} :: inlined region [${m.names.join(', ')}] drifted from ${m.source}`)
    io.err(m.diff)
  }
  if (!inline.mismatches.length) io.out(`ok    ${inline.regionCount} inlined region(s) match their source`)
  return inline.mismatches.length
}

// Matching the source is not enough: an inlined helper that calls a sibling the fence does not name
// leaves the workflow calling a function it never defines, and that is a RUNTIME error — the script
// parses, the region matches, and the run dies at the first call after the whole agent spend.
/** @param {string} dir @param {string[]} files @returns {{ unresolved: Array<{ file: string, line: number, source: string, name: string }>, sources: string[] }} */
function regionsOf(dir, files) {
  const unresolved = []
  const sources = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const regions = findRegions(text)
    sources.push(...regions.map(r => r.source))
    for (const u of unresolvedSiblings(text, regions)) unresolved.push({ file: f, ...u })
  }
  return { unresolved, sources }
}

// Inlined code is type-checked in its lib module against Node typings; the sandbox has far less.
/** @param {string} root @param {Io} io @returns {number} failures */
function sandboxNames(root, io) {
  const ts = loadTypescript(root)
  const absent = ts ? inlinedNameProblems(root, ts) : [tscMissingMessage(root)]
  for (const a of absent) io.err(`FAIL  ${a}`)
  if (!absent.length) io.out('ok    every name in inlined code resolves in the sandbox')
  return absent.length
}

// Everything inlined must be read by the strict type check, at full strictness, with nothing switched
// off — asked of tsc itself, which needs `npm ci --prefix opencode/plugin` (CI runs it before this).
/** @param {string} root @param {string[]} sources @returns {string[]} */
function scopeProblemsOf(root, sources) {
  const listed = runTsc(root, ['-p', path.join(root, 'lib', 'tsconfig.json'), '--listFilesOnly'])
  const shown = runTsc(root, ['-p', path.join(root, 'lib', 'tsconfig.json'), '--showConfig'])
  if (listed.missing || shown.missing) return [tscMissingMessage(root)]
  if (listed.status || shown.status) {
    const bad = listed.status ? listed : shown
    return [`tsc -p lib/tsconfig.json failed: ${`${bad.stdout}\n${bad.stderr}`.trim().split('\n').slice(0, 5).join(' | ')}`]
  }
  return typedScopeProblems({
    root, sources,
    typedFiles: listed.stdout.split('\n').filter(Boolean),
    config: JSON.parse(shown.stdout),
    readSource: s => fs.readFileSync(path.join(root, s), 'utf8'),
  })
}

/**
 * The whole gate for workflows/*.js; `--fix` regenerates the inlined regions in place.
 * @param {string[]} argv @param {import('./script-run.mjs').ScriptEnv & { root?: string }} [env]
 * @returns {import('./script-run.mjs').ScriptResult}
 */
export function run(argv, env = {}) {
  const io = scriptOutput(env)
  const root = env.root ?? ROOT
  const dir = path.join(root, 'workflows')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  let failed = parseScripts(dir, files, io)
  failed += versionStamps(root, dir, files, io)
  failed += inlineDrift(dir, argv.includes('--fix'), io)
  const { unresolved, sources } = regionsOf(dir, files)
  failed += sandboxNames(root, io)
  for (const u of unresolved) {
    io.err(`FAIL  ${u.file}:${u.line} :: inlined region from ${u.source} calls ${u.name}(), a sibling export of ${u.source} that the fence header does not carry — add it`)
  }
  if (!unresolved.length) io.out('ok    every inlined region resolves the helpers it calls')
  const scopeProblems = scopeProblemsOf(root, sources)
  for (const p of scopeProblems) io.err(`FAIL  ${p}`)
  if (!scopeProblems.length) io.out('ok    every inlined source is read by the strict type check, nothing switched off')
  return io.result(failed || unresolved.length || scopeProblems.length ? 1 : 0)
}

if (invokedDirectly(import.meta.url)) exitWith(run(process.argv.slice(2), { echo: true }))
