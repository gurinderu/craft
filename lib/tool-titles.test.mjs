// The report's list of verbatim tool titles (realm @nick/craft, node #236).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { toolTitlesSection } from './tool-titles.mjs'

/** @param {Record<string, unknown>} over @returns {any} */
const f = over => ({ title: 'Unused lambda pattern: self', file: 'flake.nix', line: 3, source: 'deadnix', severity: 'Low', why: 'w', ...over })

test('lists each tool finding naming no rule once, title unchanged but for whitespace', () => {
  const s = toolTitlesSection([f({}), f({ title: 'Unused lambda pattern:  pkgs' }), f({})])
  assert.ok(s.startsWith('\n\n## Tool finding titles (verbatim)\n'))
  assert.ok(s.includes('- `flake.nix:3` · Unused lambda pattern: self\n'))
  assert.ok(s.includes('- `flake.nix:3` · Unused lambda pattern: pkgs\n'))
  assert.equal(s.split('Unused lambda pattern: self').length - 1, 1, 'once')
})

test('leaves out a finding naming a rule and a review lens finding; nothing to list is no section', () => {
  assert.equal(toolTitlesSection([f({ source: 'clippy', toolRule: 'clippy::needless_clone' }), f({ source: 'safety' })]), '')
  assert.ok(toolTitlesSection([f({ source: 'clippy', title: 'Manual map over Option' })]).includes('Manual map over Option'), 'a lint without toolRule is listed')
})
