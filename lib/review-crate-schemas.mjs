// The schemas of the review engine's crateScope mode (src/review.js), and the shapes of their answers.
import { FINDING_ITEM } from './review-schemas.mjs'

/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
/**
 * @typedef {import('./review-schemas.mjs').FindingAnswer} FindingAnswer
 * @typedef {{ roots: string[] }} CratesAnswer  CRATES_SCHEMA
 * @typedef {{ crate: string, symbol: string, path: string, ask: string, findingTitle: string, findingFile: string, blocking: boolean, answered: boolean, answer: string }} QuestionAnswer  QUESTION_ITEM
 * @typedef {{ lens: string, findings: FindingAnswer[], questions?: QuestionAnswer[] }} CrateFindingsAnswer  CRATE_FINDINGS_SCHEMA
 * @typedef {{ answered: number, unanswered: number, notes: string }} CoordAnswer  COORD_SCHEMA
 * @typedef {{ lens: string, findingFile: string, findingTitle: string, action: 'confirm' | 'drop' | 'convert', why: string }} DispositionAnswer
 * @typedef {{ findings: FindingAnswer[], dispositions: DispositionAnswer[], answered: number }} SeamAnswer  SEAM_SCHEMA
 * @typedef {{ written: boolean }} StopAnswer  STOP_SCHEMA
 */

/** @type {Schema<CratesAnswer>} */
export const CRATES_SCHEMA = { type: 'object', additionalProperties: false, required: ['roots'], properties: { roots: { type: 'array', items: { type: 'string' } } } }

const QUESTION_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['crate', 'symbol', 'path', 'ask', 'findingTitle', 'findingFile', 'blocking', 'answered', 'answer'],
  properties: {
    crate: { type: 'string' }, symbol: { type: 'string' }, path: { type: 'string' }, ask: { type: 'string' },
    findingTitle: { type: 'string', description: 'title of the finding that depends on the answer; "" if none' },
    findingFile: { type: 'string', description: 'file of the finding that depends on the answer; "" if none' },
    blocking: { type: 'boolean', description: 'true if written to the channel and waited on' },
    answered: { type: 'boolean' }, answer: { type: 'string' },
  },
}

/** @type {Schema<CrateFindingsAnswer>} */
export const CRATE_FINDINGS_SCHEMA = { type: 'object', additionalProperties: false, required: ['lens', 'findings'], properties: { lens: { type: 'string' }, findings: { type: 'array', items: FINDING_ITEM }, questions: { type: 'array', items: QUESTION_ITEM } } }

/** @type {Schema<CoordAnswer>} */
export const COORD_SCHEMA = { type: 'object', additionalProperties: false, required: ['answered', 'unanswered', 'notes'], properties: { answered: { type: 'number' }, unanswered: { type: 'number' }, notes: { type: 'string' } } }

const DISPOSITION_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'findingFile', 'findingTitle', 'action', 'why'],
  properties: { lens: { type: 'string' }, findingFile: { type: 'string' }, findingTitle: { type: 'string' }, action: { type: 'string', enum: ['confirm', 'drop', 'convert'] }, why: { type: 'string' } },
}

/** @type {Schema<SeamAnswer>} */
export const SEAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'dispositions', 'answered'],
  properties: { findings: { type: 'array', items: FINDING_ITEM }, dispositions: { type: 'array', items: DISPOSITION_ITEM }, answered: { type: 'number' } },
}

/** @type {Schema<StopAnswer>} */
export const STOP_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean', description: 'true when ls printed the stop file' } } }
