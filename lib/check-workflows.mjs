// Syntax-checks the scripts in workflows/ (generated from src/ by lib/build-engines.mjs). They can't be `node --check`'d directly: each combines a
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
import { outputLines, runIfMain } from './script-main.mjs'
import { launchKnown, launchProblems } from './launch-names.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @typedef {{ stdout: string[], stderr: string[] }} Lines */

/** @param {string} dir @param {string[]} files @param {Lines} o @returns {number} failures */
function parseScripts(dir, files, o) {
  let bad = 0
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^export const meta/m, 'const meta')
    try {
      new Function(`async function __wf(){\n${src}\n}`)
      o.stdout.push(`ok    ${f}`)
    } catch (e) {
      bad++
      o.stderr.push(`FAIL  ${f} :: ${/** @type {Error} */ (e).message}`)
    }
  }
  o.stdout.push(`\n${files.length - bad}/${files.length} workflow scripts parse`)
  // `0/0 workflow scripts parse` used to exit 0: nothing was compiled, and the run was indistinguishable
  // from one where everything compiled. craft always ships workflow scripts, so an empty directory here
  // means the checker is pointed at the wrong place — a misconfiguration, reported as one.
  if (!files.length) {
    o.stderr.push('FAIL  workflows/ :: no .js scripts found — nothing was checked (this is a misconfiguration, not a pass)')
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
/** @param {string} root @param {string} dir @param {string[]} files @param {Lines} o @returns {number} failures */
function versionStamps(root, dir, files, o) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  const stamps = checkVersionStamps(files.map(f => ({ name: f, src: fs.readFileSync(path.join(dir, f), 'utf8') })), manifest.version)
  for (const line of stamps.oks) o.stdout.push(`ok    ${line}`)
  for (const line of stamps.failures) o.stderr.push(`FAIL  ${line}`)
  return stamps.failures.length
}

// The sandbox cannot import, so shared helpers are pasted into the workflow scripts. Each pasted
// block is fenced (`// >>> craft-inline <source> <names…>`); regenerate it from the source and
// compare byte-for-byte, so a copy can never quietly drift from its original again. Lives here
// rather than in a sibling script because this file already IS the gate for workflows/*.js and is
// already wired into CI — a second entry point would just be another thing to forget to run.
// `--fix` regenerates the regions in place; without it the checker is read-only.
/** @param {string} root @param {string} dir @param {boolean} fix @param {Lines} o @returns {number} failures */
function inlineDrift(root, dir, fix, o) {
  // The compiler judges each region's comment stripping. It is a tool, not part of the checkout under
  // check: the checkout's own install, else this checker's; with neither, every region is refused.
  const inline = checkAll({ root, dir, fix, ts: loadTypescript(root) ?? loadTypescript(ROOT) })
  for (const m of inline.mismatches) {
    o.stderr.push(`FAIL  ${m.file}:${m.line} :: inlined region [${m.names.join(', ')}] drifted from ${m.source}`)
    o.stderr.push(m.diff)
  }
  // A refused region is one the checker could not make: its stripping changed the program, or tsc is not
  // there to judge that (fail closed). `--fix` leaves it as it was.
  for (const r of inline.refusals) {
    o.stderr.push(`FAIL  ${r.file}:${r.line} :: inlined region from ${r.source} refused — ${r.reason}`)
  }
  const failures = inline.mismatches.length + inline.refusals.length
  if (!failures) o.stdout.push(`ok    ${inline.regionCount} inlined region(s) match their source`)
  return failures
}

// Matching the source is not enough: an inlined helper that calls a sibling the fence does not name
// leaves the workflow calling a function it never defines, and that is a RUNTIME error — the script
// parses, the region matches, and the run dies at the first call after the whole agent spend.
/** @param {string} root @param {string} dir @param {string[]} files @returns {{ unresolved: Array<{ file: string, line: number, source: string, name: string }>, sources: string[] }} */
function regionsOf(root, dir, files) {
  const unresolved = []
  const sources = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const regions = findRegions(text)
    sources.push(...regions.map(r => r.source))
    for (const u of unresolvedSiblings(text, regions, s => fs.readFileSync(path.join(root, s), 'utf8'))) unresolved.push({ file: f, ...u })
  }
  return { unresolved, sources }
}

// Inlined code is type-checked in its lib module against Node typings; the sandbox has far less.
/** @param {string} root @param {Lines} o @returns {number} failures */
function sandboxNames(root, o) {
  const ts = loadTypescript(root)
  const absent = ts ? inlinedNameProblems(root, ts) : [tscMissingMessage(root)]
  for (const a of absent) o.stderr.push(`FAIL  ${a}`)
  if (!absent.length) o.stdout.push('ok    every name in inlined code resolves in the sandbox')
  return absent.length
}

// Everything inlined must be read by the strict type check, at full strictness, with nothing switched
// off — asked of tsc itself, which needs `npm ci --prefix opencode/plugin` (CI runs it before this).
/** @param {string} root @param {string[]} sources @returns {string[]} */
function scopeProblemsOf(root, sources) {
  const ts = loadTypescript(root)
  const listed = runTsc(root, ['-p', path.join(root, 'lib', 'tsconfig.json'), '--listFilesOnly'])
  const shown = runTsc(root, ['-p', path.join(root, 'lib', 'tsconfig.json'), '--showConfig'])
  if (listed.missing || shown.missing || !ts) return [tscMissingMessage(root)]
  if (listed.status || shown.status) {
    const bad = listed.status ? listed : shown
    return [`tsc -p lib/tsconfig.json failed: ${`${bad.stdout}\n${bad.stderr}`.trim().split('\n').slice(0, 5).join(' | ')}`]
  }
  return typedScopeProblems({
    root, sources,
    typedFiles: listed.stdout.split('\n').filter(Boolean),
    config: JSON.parse(shown.stdout),
    readSource: s => fs.readFileSync(path.join(root, s), 'utf8'),
    ts,
  })
}

// Every launch an engine makes — a `workflow(…)` call, a call handed `workflow` to launch through, an
// agent-type property — must reach the harness under the plugin-prefixed name (realm @nick/craft, #83).
/** @param {string} root @param {string} dir @param {string[]} files @param {Lines} o @returns {number} failures */
function launchNames(root, dir, files, o) {
  const ts = loadTypescript(root)
  if (!ts) { o.stderr.push(`FAIL  ${tscMissingMessage(root)}`); return 1 }
  const engines = files.map(f => ({ f, src: fs.readFileSync(path.join(dir, f), 'utf8') }))
  const { seen, problems } = launchProblems(ts, engines, launchKnown(root))
  for (const p of problems) o.stderr.push(`FAIL  ${p}`)
  if (!problems.length) o.stdout.push(`ok    ${seen} launch site(s) name the harness's prefixed id`)
  return problems.length
}

/** @param {string} dir @returns {string[]} its `.js` files, none when it is absent */
const enginesIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : [])

/**
 * The whole gate for workflows/*.js and their sources in src/; `--fix` regenerates the inlined regions in src/
 * in place (then `npm run build:engines`).
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: it reads no environment
 * @param {string} [root]  the checkout to check
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, root = ROOT) {
  /** @type {Lines} */
  const o = outputLines()
  // What ships is compiled, stamped and launch-checked; the regions are checked where they are authored —
  // workflows/ carries no fences (lib/build-engines.mjs).
  const dir = path.join(root, 'workflows')
  const files = enginesIn(dir)
  const srcDir = path.join(root, 'src')
  const srcFiles = enginesIn(srcDir)
  let failed = parseScripts(dir, files, o)
  failed += versionStamps(root, dir, files, o)
  failed += inlineDrift(root, srcDir, argv.includes('--fix'), o)
  const { unresolved, sources } = regionsOf(root, srcDir, srcFiles)
  failed += sandboxNames(root, o)
  failed += launchNames(root, dir, files, o)
  for (const u of unresolved) {
    o.stderr.push(`FAIL  ${u.file}:${u.line} :: inlined region from ${u.source} calls ${u.name}(), a sibling export of ${u.source} that the fence header does not carry — add it`)
  }
  if (!unresolved.length) o.stdout.push('ok    every inlined region resolves the helpers it calls')
  const scopeProblems = scopeProblemsOf(root, sources)
  for (const p of scopeProblems) o.stderr.push(`FAIL  ${p}`)
  if (!scopeProblems.length) o.stdout.push('ok    every inlined source is read by the strict type check, nothing switched off')
  return { exitCode: failed || unresolved.length || scopeProblems.length ? 1 : 0, ...o }
}

await runIfMain(import.meta.url, run)
