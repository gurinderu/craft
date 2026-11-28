// The scripted `craft audit` the audit engine's tests drive through integrations/shared/engine-harness.mjs: the service
// agent's command output standing in for the binary — its pending and finished steps and its status, in the shapes
// `craft audit submit | status` print (cli/crates/craft-audit/src/step.rs, step/finish.rs, step/status.rs) —, a task
// agent that writes its answer file as a real one would, and what a run asked its service steps to run. Test
// infrastructure: only tests reach it.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseJsonObject } from './json-object.mjs'

/** @typedef {{ calls: { label: string, prompt: string }[] }} EngineRun */

/** The release the engine is stamped with: the plugin manifest's, which release-please moves with it. */
/** @type {{ version: string }} */
const MANIFEST = parseJsonObject(readFileSync(new URL('../claude-code/.claude-plugin/plugin.json', import.meta.url), 'utf8'))
export const VERSION = MANIFEST.version

/** A service agent's answer carrying `value` as stdout. @param {unknown} value @param {number} [exitCode] @param {string} [stderr] */
export const ran = (value, exitCode = 0, stderr = '') => ({ exitCode, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr })

/** The fetch of the released binary, with the plugin root its fetcher was found in. */
export const RESOLVED = ran('root=/p/craft\nbin=/b/craft\n')

/** The label the binary gives a lens task. */
export const LENS_LABEL = 'rust errors · batch 1 (2 file(s))'

/** A task as the binary prints it. @param {string} run @param {string} id @param {string} label @param {string} model @param {string} kind */
const task = (run, id, label, model, kind) => ({
  id,
  label,
  model,
  kind,
  promptFile: `${run}/tasks/${id}.md`,
  schemaFile: `${run}/tasks/${id}.schema.json`,
  answerFile: `${run}/answers/${id}.json`,
})

/** The lens task of the first pass. @param {string} run */
export const lens = run => task(run, 'lens-1-rust-errors-0', LENS_LABEL, 'sonnet', 'lens')
/** Its verifier. @param {string} run */
export const verify = run => task(run, 'verify-1-0', 'verify 1 rust finding(s)', 'opus', 'verify')

/** A pending step. @param {string} run @param {object[]} tasks @param {string} [phase] */
export const pending = (run, tasks, phase = 'lens') => ran({ run, done: false, phase, pass: 1, repo: '/work/repo', tasks })

/** The binary's finished step, Warning with nothing left. @param {string} run @param {Record<string, unknown>} [more] */
export const done = (run, more = {}) =>
  ran({
    run,
    done: true,
    phase: 'done',
    pass: 1,
    verdict: 'Warning',
    report: `${run}/report.md`,
    recordFile: `${run}/record.json`,
    filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
    ...more,
  })

/**
 * `craft audit status` of a pass that ended: the run's phase, pass and task lines, and the finished step's fields it
 * copies from `finished.json`. @param {string} run @param {Record<string, unknown>} [more]
 */
export const endedStatus = (run, more = {}) =>
  ran({
    run,
    phase: 'done',
    pass: 1,
    done: true,
    tasks: [{ id: 'lens-1-rust-errors-0', label: LENS_LABEL, state: 'answered', retries: 0, error: null }],
    verdict: 'Warning',
    report: `${run}/report.md`,
    recordFile: `${run}/record.json`,
    filing: { file: '/store/audit.json', lost: [], pass: 1, record: 'filed' },
    ...more,
  })

/** `craft audit status` of a run still going. @param {string} run @param {Record<string, unknown>} [more] */
export const goingStatus = (run, more = {}) =>
  ran({
    run,
    phase: 'lens',
    pass: 1,
    done: false,
    tasks: [{ id: 'lens-1-rust-errors-0', label: LENS_LABEL, state: 'pending', retries: 0, error: null }],
    ...more,
  })

/** A task agent that writes `answer` to the answer file its prompt names. @param {unknown} answer */
export const writes =
  answer =>
  (/** @type {{ prompt: string }} */ { prompt }) => {
    const file = /to (\/\S+\.json) \(create/.exec(prompt)?.[1]
    assert.ok(file, prompt)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(answer))
    return 'done'
  }

/** The command a service step was asked to run. @param {EngineRun} run @param {string} label */
export const command = (run, label) => {
  const c = run.calls.find(x => x.label === label)
  assert.ok(c, `no ${label}: ${run.calls.map(x => x.label).join(', ')}`)
  return /\n\n(.+)\n\nReturn \{exitCode/s.exec(c.prompt)?.[1] ?? ''
}

/** The record writes a run dispatched. @param {EngineRun} run */
export const logged = run => run.calls.filter(c => /^log-run/.test(c.label))

/** Each call's label without its discriminator. @param {EngineRun} run */
export const labels = run => run.calls.map(c => c.label.replace(/:.*$/, ''))
