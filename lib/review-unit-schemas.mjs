// The schemas of the review engine's unitScope mode (src/review.js), and the shapes of their answers.
import { FINDING_ITEM } from './review-schemas.mjs'

/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
/**
 * @typedef {import('./review-schemas.mjs').FindingAnswer} FindingAnswer
 * @typedef {{ roots: string[], packages?: string[], numstat?: string[], error?: string }} UnitsAnswer  UNITS_SCHEMA
 * @typedef {{ unit: string, symbol: string, path: string, ask: string, findingTitle: string, findingFile: string, blocking: boolean, answered: boolean, answer: string, source?: string }} QuestionAnswer  QUESTION_ITEM
 * @typedef {{ lens: string, findings: FindingAnswer[], questions?: QuestionAnswer[] }} UnitFindingsAnswer  UNIT_FINDINGS_SCHEMA
 * @typedef {{ answered: number, unanswered: number, notes: string }} CoordAnswer  COORD_SCHEMA
 * @typedef {{ lens: string, findingFile: string, findingTitle: string, action: 'confirm' | 'drop' | 'convert', why: string }} DispositionAnswer
 * @typedef {{ findings: FindingAnswer[], dispositions: DispositionAnswer[], answered: number }} SeamAnswer  SEAM_SCHEMA
 * @typedef {{ written: boolean }} StopAnswer  STOP_SCHEMA
 */

/** @type {Schema<UnitsAnswer>} */
export const UNITS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['roots'],
  properties: {
    roots: { type: 'array', items: { type: 'string' } },
    packages: { type: 'array', items: { type: 'string' }, description: 'every line the packages command printed, verbatim' },
    numstat: { type: 'array', items: { type: 'string' }, description: 'every line the numstat command printed, verbatim' },
    // The units CLI's failure (lib/craft-units.mjs; realm @nick/craft, #377): the probe failed, with this text.
    error: { type: 'string', description: 'the units CLI\'s error, verbatim, when it printed one; absent otherwise' },
  },
}

const QUESTION_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['unit', 'symbol', 'path', 'ask', 'findingTitle', 'findingFile', 'blocking', 'answered', 'answer'],
  properties: {
    unit: { type: 'string' }, symbol: { type: 'string' }, path: { type: 'string' }, ask: { type: 'string' },
    findingTitle: { type: 'string', description: 'title of the finding that depends on the answer; "" if none' },
    findingFile: { type: 'string', description: 'file of the finding that depends on the answer; "" if none' },
    blocking: { type: 'boolean', description: 'true if written to the channel and waited on' },
    answered: { type: 'boolean' }, answer: { type: 'string' },
  },
}

const UNIT_FINDINGS_PROPS = { lens: { type: 'string' }, findings: { type: 'array', items: FINDING_ITEM }, questions: { type: 'array', items: QUESTION_ITEM } }
/** @type {Schema<UnitFindingsAnswer>} */
export const UNIT_FINDINGS_SCHEMA = { type: 'object', additionalProperties: false, required: ['lens', 'findings'], properties: UNIT_FINDINGS_PROPS }

// A sectioned agent of several lenses (realm @nick/craft, #355): each finding's `source` is one of its lenses,
// and so is each question's — the lens of the finding that depends on it, which the seam pass's disposition
// names (#321): the bundle's name would match no finding.
/** @param {string[]} lenses @returns {Schema<UnitFindingsAnswer>} */
export function multiLensSchema(lenses) {
  const source = { type: 'string', enum: lenses, description: 'the lens (section) this finding belongs to' }
  const findings = { type: 'array', items: { ...FINDING_ITEM, properties: { ...FINDING_ITEM.properties, source } } }
  const qSource = { ...source, description: 'the lens (section) of the finding that depends on the answer' }
  const questions = { type: 'array', items: { ...QUESTION_ITEM, required: [...QUESTION_ITEM.required, 'source'], properties: { ...QUESTION_ITEM.properties, source: qSource } } }
  return { ...UNIT_FINDINGS_SCHEMA, properties: { ...UNIT_FINDINGS_PROPS, findings, questions } }
}

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
