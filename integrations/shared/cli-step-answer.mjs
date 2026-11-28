// The parts of a step-protocol driver's answer every kind shares (integrations/shared/cli-step-driver.mjs; realm
// @nick/craft, node #453): how a stopped run is resumed, the INCOMPLETE heading, and the answer of a run the binary
// held on the usage limit. What a finished run's answer says is the kind's own.
import { telemetryLostSection } from './review-coverage.mjs'

/** @typedef {import('./cli-step-read.mjs').KindFinished} KindFinished */

/** How a stopped run of the Workflow `engine` is resumed once agents answer again. @param {string} engine @param {string} run */
export const resumeHint = (engine, run) => `To resume it once agents can answer again: the Workflow \`craft:${engine} run=${run}\` alone.`

/** `answer`, then each note that says something. @param {string} answer @param {string[]} notes */
export const withNotes = (answer, notes) => [answer, ...notes.filter(Boolean)].join('\n\n')

/** @param {string} title @param {string} why @returns {string} */
export const incompleteAnswer = (title, why) => `## ${title}\n\n⚠️ INCOMPLETE — ${why}`

/** The notes of a finished step: each write that did not land, then what the run noted. @param {KindFinished} step @returns {string[]} */
export const finishedNotes = step => [telemetryLostSection(step.filing?.lost ?? []).trim(), ...step.notes]

/**
 * The answer of a run the binary held on the usage limit: INCOMPLETE, where it is and how to resume it, filed by no one
 * until the resumed run finishes.
 * @param {string} title @param {string} engine @param {KindFinished} step @returns {string}
 */
export const stoppedAnswer = (title, engine, step) =>
  withNotes(incompleteAnswer(title, `${step.line || 'the run stopped'}. The run is in ${step.run}. ${resumeHint(engine, step.run)}`), [
    'No run record is filed until the resumed run finishes.',
    ...finishedNotes(step),
  ])
