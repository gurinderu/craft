// Spike (realm @nick/craft, #208): import-based bundling of one engine. Tries the naive build first,
// then the smallest working shape, and prints what each produced.
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const base = { bundle: true, format: 'esm', platform: 'neutral', write: false, legalComments: 'none', charset: 'utf8', target: 'esnext', logLevel: 'silent' }

async function attempt(label, opts) {
  try {
    const r = await esbuild.build({ ...base, ...opts })
    const code = r.outputFiles[0].text
    console.log(`\n--- ${label}: OK, ${Buffer.byteLength(code)} bytes, imports left: ${(code.match(/^\s*import\b|\bimport\s*\(/gm) ?? []).length}, starts with meta literal: ${code.startsWith('export const meta = {') || code.startsWith('export const meta={')}`)
    console.log(code.slice(0, 300).replace(/\n/g, '\n  | '))
    console.log('  ... tail:', JSON.stringify(code.slice(-200)))
    return code
  } catch (e) {
    console.log(`\n--- ${label}: FAILED\n  ${(e.errors ?? []).map(x => `${x.location?.line}:${x.location?.column} ${x.text}`).join('\n  ') || e.message}`)
    return null
  }
}

// 1. naive: the engine as-is with an import in place of the fence
await attempt('naive (top-level return kept)', { entryPoints: [path.join(HERE, 'src', 'nix-review.js')] })

// 2. smallest working shape: meta in its own module, the body as `export async function run()`;
//    the build emits meta as a banner and the top-level `return await run()` as a footer.
const src = fs.readFileSync(path.join(HERE, 'src', 'nix-review.js'), 'utf8')
const metaEnd = src.indexOf('\n}\n') + 3
const metaText = src.slice(0, metaEnd)
const body = src.slice(metaEnd)
  .replace(/^import .*$/m, m => m)   // imports stay at module top level
const imports = body.match(/^import .*$/gm) ?? []
const rest = body.replace(/^import .*$/gm, '')
const lastReturn = rest.lastIndexOf('\nreturn ')
const entry = [...imports, 'export async function __run() {', rest.slice(0, lastReturn), rest.slice(lastReturn).replace('\nreturn ', '\nreturn '), '}', ''].join('\n')
fs.writeFileSync(path.join(HERE, 'src', 'nix-review.entry.js'), entry)
// `export async function __run` stays as an export in the bundle; strip that one export statement after
const code = await attempt('meta banner + body in a function + footer call', {
  entryPoints: [path.join(HERE, 'src', 'nix-review.entry.js')],
  banner: { js: metaText.trimEnd() },
  footer: { js: 'return await __run()' },
})
if (code) {
  const fixed = code.replace(/\nexport \{\s*__run\s*\};?\n/, '\n')
  fs.writeFileSync(path.join(HERE, 'out', 'nix-review.bundled.js'), fixed)
  let parse = 'ok'
  try { new Function(`async function __wf(){\n${fixed.replace(/^export const meta/m, 'const meta')}\n}`) } catch (e) { parse = 'FAIL ' + e.message }
  console.log(`\nafter dropping the trailing \`export { __run }\`: ${Buffer.byteLength(fixed)} bytes, exports left: ${(fixed.match(/^export\b/gm) ?? []).length}, sandbox parse: ${parse}`)
}
