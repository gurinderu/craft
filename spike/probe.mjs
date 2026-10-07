// Spike probe: does esbuild transform accept an engine as-is (top-level export + await + return)?
import * as esbuild from 'esbuild'
import fs from 'node:fs'
const src = fs.readFileSync(new URL('../workflows/nix-review.js', import.meta.url), 'utf8')
try {
  const r = await esbuild.transform(src, { format: 'esm', minifyWhitespace: true, minifySyntax: true, legalComments: 'none' })
  console.log(r.code.slice(0, 400)); console.log(r.warnings)
} catch (e) { console.log('ERR', String(e.message).slice(0, 800)) }
