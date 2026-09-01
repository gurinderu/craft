// Syntax-checks the scripts in workflows/. They can't be `node --check`'d directly: each combines a
// top-level `export`, top-level `await`, and top-level `return` — a trio that is only legal inside
// the workflow sandbox's wrapper. We reproduce that wrapper (strip the single leading `export`, wrap
// the body in an async function) and let `new Function` compile-check it. Exits non-zero on any
// syntax error so CI fails loudly. This does NOT run the scripts — sandbox globals (agent, parallel,
// phase, budget, log, workflow, args) stay unresolved free identifiers, which is fine for a parse.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAll } from './inline-regions.mjs'
import { checkVersionStamps } from './workflow-version.mjs'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
let bad = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^export const meta/m, 'const meta')
  try {
    new Function(`async function __wf(){\n${src}\n}`)
    console.log('ok   ', f)
  } catch (e) {
    bad++
    console.error('FAIL ', f, '::', e.message)
  }
}
console.log(`\n${files.length - bad}/${files.length} workflow scripts parse`)

// A workflow that files its own run record must stamp CRAFT_VERSION on it, and that stamp must
// agree with the plugin manifest. Two ways to lose this, and both used to be silent: the stamp
// drifts (every record from here on is labelled with a version that was never released), or the
// stamp is simply absent (records go back to being version-less). The old check `continue`d on
// absence, so a deleted line — or a new record-filing workflow that never got one — read exactly
// like a pass. Which workflows must carry it is derived from the source, not listed: see
// lib/workflow-version.mjs.
const manifest = JSON.parse(fs.readFileSync(path.resolve(dir, '..', '.claude-plugin', 'plugin.json'), 'utf8'))
const stamps = checkVersionStamps(files.map(f => ({ name: f, src: fs.readFileSync(path.join(dir, f), 'utf8') })), manifest.version)
for (const line of stamps.oks) console.log(`ok    ${line}`)
for (const line of stamps.failures) console.error(`FAIL  ${line}`)
const drift = stamps.failures.length

// The sandbox cannot import, so shared helpers are pasted into the workflow scripts. Each pasted
// block is fenced (`// >>> craft-inline <source> <names…>`); regenerate it from the source and
// compare byte-for-byte, so a copy can never quietly drift from its original again. Lives here
// rather than in a sibling script because this file already IS the gate for workflows/*.js and is
// already wired into CI — a second entry point would just be another thing to forget to run.
// `--fix` regenerates the regions in place; without it the checker is read-only.
const inline = checkAll({ fix: process.argv.includes('--fix') })
for (const m of inline.mismatches) {
  console.error(`FAIL  ${m.file}:${m.line} :: inlined region [${m.names.join(', ')}] drifted from ${m.source}`)
  console.error(m.diff)
}
if (!inline.mismatches.length) {
  console.log(`ok    ${inline.regionCount} inlined region(s) match their source`)
}
process.exit(bad || drift || inline.mismatches.length ? 1 : 0)
