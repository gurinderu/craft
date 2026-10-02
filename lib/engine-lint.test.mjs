// The engine lint loads ESLint and typescript-eslint from the repo root's own node_modules, never a
// parent directory's: a checkout nested inside another (.claude/worktrees/*) must not lint with the
// outer checkout's packages.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadEngineLinter } from './engine-lint.mjs'
import { ROOT } from './inline-regions.mjs'

// Without the root install these skip locally; in CI they run and fail, so a missing install is never a
// green run (Vitest's skip option carries no reason to report). Needs npm ci.
const needsRootInstall = fs.existsSync(path.join(ROOT, 'node_modules', 'eslint', 'package.json')) || process.env['CI'] ? {} : { skip: true }

test('a root without its own install fails closed, even under a parent that has ESLint', needsRootInstall, () => {
  // Nested under this checkout, whose node_modules holds ESLint: a parent-walking lookup would find it.
  const nested = fs.mkdtempSync(path.join(ROOT, '.engine-lint-nested-'))
  try {
    fs.writeFileSync(path.join(nested, 'package.json'), '{"private":true}')
    const got = loadEngineLinter(nested)
    assert.equal(typeof got, 'string', 'the parent checkout\'s ESLint was used')
    assert.match(String(got), /node_modules\/eslint/)
    assert.match(String(got), /run npm ci/)
  } finally { fs.rmSync(nested, { recursive: true, force: true }) }
})

test('a root with its own install loads its linter', needsRootInstall, () => {
  assert.notEqual(typeof loadEngineLinter(ROOT), 'string')
})
