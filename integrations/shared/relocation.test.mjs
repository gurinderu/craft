import { onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from './repo-root.mjs'
import { materialize } from './materialize-claude-code.mjs'
import { binaryName } from './craft-bin.mjs'
import { layPackage } from './opencode-package.mjs'
import { checkMutationFloor, floorProblems } from './check-mutation-floor.mjs'
import { historicalIdentity, layoutPath } from './layout-paths.mjs'
import { run as boundary } from './check-js-boundary.mjs'
import { functionsFromMessages, isEngineFile, COMPLEXITY, VALUE } from './quality-tally.mjs'

function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-relocation-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the isolated Claude Code package runs its commands and resolves every engine map source', () => {
  const root = materialize(ROOT, temporary())
  assert.equal(fs.existsSync(path.join(root, 'src')), false)
  assert.equal(fs.existsSync(path.join(root, 'lib')), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
  // `ensure` takes the cached copy of the manifest version, so the test seeds one in its own HOME: the version may be
  // unreleased (a release PR). A miss downloads through craft-fetch.sh (curl or wget), which the proxy variables and
  // the API base below send to a closed local port, failing fast; on win32 `ensure` downloads with Node's own HTTP
  // client instead, which they do not cover (CI's vitest job does not run there).
  const home = temporary()
  const cached = path.join(home, '.craft', 'bin', manifest.version, binaryName(process.platform))
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  fs.writeFileSync(cached, '#!/bin/sh\n', { mode: 0o755 })
  const closed = 'http://127.0.0.1:9'
  const offline = {
    CRAFT_API_BASE: closed,
    HTTPS_PROXY: closed,
    https_proxy: closed,
    HTTP_PROXY: closed,
    http_proxy: closed,
    ALL_PROXY: closed,
    all_proxy: closed,
    NO_PROXY: '',
    no_proxy: '',
  }
  const ensure = (/** @type {string} */ dir) =>
    spawnSync(process.execPath, ['integrations/shared/craft-bin.mjs', 'ensure'], {
      cwd: root,
      env: { ...process.env, ...offline, HOME: dir, USERPROFILE: dir, CLAUDE_PLUGIN_ROOT: '/missing/other-plugin' },
      encoding: 'utf8',
    })
  const r = ensure(home)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), cached)
  assert.match(r.stdout, new RegExp(manifest.version.replaceAll('.', '\\.')))
  // With no cached copy the package's own craft-fetch.sh runs, sources craft-fetch-http.sh and falls back to the API.
  const miss = ensure(temporary())
  assert.equal(miss.status, 1, miss.stdout)
  assert.match(miss.stderr, /^craft-bin: could not download \S+; then through the API: could not download http:\/\/127\.0\.0\.1:9\//)
  for (const name of fs.readdirSync(path.join(root, 'workflows')).filter(f => f.endsWith('.map'))) {
    const map = JSON.parse(fs.readFileSync(path.join(root, 'workflows', name), 'utf8'))
    for (const source of map.sources) assert.ok(fs.existsSync(path.resolve(root, 'workflows', source)), `${name}: ${source}`)
  }
})

test('the isolated OpenCode package includes the dynamically loaded writer lock and shell helpers', () => {
  const root = layPackage(ROOT, temporary())
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    let locked = 0;
    const append = fs.appendFileSync;
    fs.appendFileSync = (file, ...args) => {
      if (String(file).endsWith('index.jsonl')) {
        if (!fs.existsSync(path.join(path.dirname(file), 'index.jsonl.lock'))) throw new Error('unlocked append');
        locked++;
      }
      return append(file, ...args);
    };
    syncBuiltinESMExports();
    const { writeRecord } = await import('./integrations/opencode/plugin/run-record.mjs');
    await writeRecord({directory: process.cwd(), sh: async () => ''}, {kind:'workflow', name:'relocation', verdict:'Warning'});
    if (locked !== 1) throw new Error('the packaged writer did not acquire its lock');
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, HOME: temporary() },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  for (const f of ['craft-fetch.sh', 'craft-fetch-http.sh']) assert.ok(fs.existsSync(path.join(root, 'integrations/shared', f)))
})

test('the historical floor is read from lib and still refuses a lower floor, missing pi or a new exclusion', async () => {
  const root = temporary()
  /** @param {string[]} args */
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  fs.mkdirSync(path.join(root, 'lib'))
  const old = { break: 70, mutate: ['lib/**/*.mjs', '!lib/**/*.test.mjs'] }
  fs.writeFileSync(path.join(root, 'lib/mutation-floor.json'), JSON.stringify(old))
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  fs.mkdirSync(path.join(root, 'integrations/shared/config'), { recursive: true })
  const floor = {
    break: 70,
    mutate: [
      'integrations/shared/**/*.mjs',
      'integrations/pi/pi-extension.mjs',
      '!integrations/shared/config/**',
      '!integrations/shared/fixtures/**',
      '!integrations/shared/**/*.test.mjs',
    ],
  }
  fs.writeFileSync(path.join(root, 'integrations/shared/mutation-floor.json'), JSON.stringify(floor))
  fs.writeFileSync(
    path.join(root, 'integrations/shared/config/stryker.config.mjs'),
    "import fs from 'node:fs'; const f = JSON.parse(fs.readFileSync(new URL('../mutation-floor.json', import.meta.url))); export default {mutate:f.mutate, thresholds:{break:f.break}}",
  )
  assert.deepEqual(await checkMutationFloor(root, 'HEAD'), [])
  assert.ok(floorProblems({ ...floor, break: 69 }, old).length)
  assert.ok(floorProblems({ ...floor, mutate: floor.mutate.filter(g => !g.includes('pi-extension')) }, old).length)
  assert.ok(floorProblems({ ...floor, mutate: [...floor.mutate, '!integrations/shared/review-*.mjs'] }, old).length)
})

test('old and new checkouts select their own layout and known relocation identities compare alike', () => {
  const root = temporary()
  assert.equal(layoutPath(root, 'integrations/shared/config/eslint.config.mjs', 'eslint.config.mjs'), 'eslint.config.mjs')
  fs.mkdirSync(path.join(root, 'integrations/shared/config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'integrations/shared/config/eslint.config.mjs'), '')
  assert.equal(layoutPath(root, 'integrations/shared/config/eslint.config.mjs', 'eslint.config.mjs'), 'integrations/shared/config/eslint.config.mjs')
  assert.equal(historicalIdentity('integrations/pi/pi-extension.mjs Function x #1'), 'lib/pi-extension.mjs Function x #1')
  assert.equal(historicalIdentity('integrations/claude-code/src/review.js'), 'src/review.js')
  assert.equal(historicalIdentity('integrations/shared/config/new.mjs'), 'integrations/shared/config/new.mjs')
  const keys = ['src/review.js', 'integrations/claude-code/src/review.js'].map(file => {
    assert.ok(isEngineFile(file))
    return functionsFromMessages(
      [{ filePath: path.join(root, file), messages: [{ ruleId: COMPLEXITY, line: 1, message: "Function 'run' has a complexity of 3." }] }],
      root,
      COMPLEXITY,
      /** @type {RegExp} */ (VALUE[COMPLEXITY]),
    ).functions[0]?.key
  })
  assert.equal(keys[0], keys[1])
})

test('a tracked JavaScript file outside integrations fails the boundary assertion', () => {
  const root = temporary()
  execFileSync('git', ['init', '-q'], { cwd: root })
  fs.writeFileSync(path.join(root, 'outside.js'), '')
  execFileSync('git', ['add', 'outside.js'], { cwd: root })
  assert.equal(boundary([], {}, root).exitCode, 1)
  fs.rmSync(path.join(root, 'outside.js'))
  assert.equal(boundary([], {}, root).exitCode, 1, 'a missing working file is still tracked until its deletion is staged')
})
