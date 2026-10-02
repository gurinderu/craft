import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertLintPrerequisites, lintPrerequisiteProblems } from './lint-prerequisites.mjs'

/** A repo root with a root and an opencode/plugin package.json, and the listed packages installed. */
function fixture(/** @type {string[]} */ installed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lintpre-'))
  fs.mkdirSync(path.join(root, 'opencode', 'plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@types/node': '22.0.0' } }))
  fs.writeFileSync(path.join(root, 'opencode', 'plugin', 'package.json'),
    JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.0.0' }, devDependencies: { typescript: '5.9.3' } }))
  for (const rel of installed) {
    fs.mkdirSync(path.join(root, rel), { recursive: true })
    fs.writeFileSync(path.join(root, rel, 'package.json'), '{}')
  }
  return root
}

test('without the plugin install, lint refuses and names npm ci --prefix opencode/plugin', () => {
  const root = fixture(['node_modules/@types/node'])
  try {
    const problems = lintPrerequisiteProblems(root)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /opencode\/plugin\/node_modules\/@opencode-ai\/plugin, opencode\/plugin\/node_modules\/typescript/)
    assert.match(problems[0] ?? '', /npm ci --prefix opencode\/plugin/)
    assert.throws(() => assertLintPrerequisites(root), /npm ci --prefix opencode\/plugin/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('without the root install, lint refuses and names npm ci', () => {
  const root = fixture(['opencode/plugin/node_modules/@opencode-ai/plugin', 'opencode/plugin/node_modules/typescript'])
  try {
    const problems = lintPrerequisiteProblems(root)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /node_modules\/@types\/node .*run npm ci(?! --prefix)/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('with both installs, nothing is missing', () => {
  const root = fixture(['node_modules/@types/node', 'opencode/plugin/node_modules/@opencode-ai/plugin', 'opencode/plugin/node_modules/typescript'])
  try {
    assert.deepEqual(lintPrerequisiteProblems(root), [])
    assert.doesNotThrow(() => assertLintPrerequisites(root))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
