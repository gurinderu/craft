// The schemas of the review engine's unitScope mode (src/review.js), and the shapes of their answers.
// The judging ones — a confined lens's findings and the seam pass's — are data in content/schemas/ (lib/content.mjs,
// realm @nick/craft, #445); the rest answer service steps and stay here.
import { FINDING_ITEM } from './review-schemas.mjs'
import { resolveRefs } from './content.mjs'
import unitFindingsSchema from '../content/schemas/unit-findings.schema.json' with { type: 'json' }
import seamSchema from '../content/schemas/seam.schema.json' with { type: 'json' }

const UNIT_FINDING_REF = { 'finding-item.schema.json': FINDING_ITEM }

/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
/**
 * @typedef {import('./review-schemas.mjs').FindingAnswer} FindingAnswer
 * @typedef {{ roots: string[], packages?: string[], numstat?: string[], error?: string }} UnitsAnswer  UNITS_SCHEMA
 * @typedef {{ unit: string, symbol: string, path: string, ask: string, findingTitle: string, findingFile: string, blocking: boolean, answered: boolean, answer: string }} QuestionAnswer  QUESTION_ITEM
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
    // Both the units CLI (lib/craft-units.mjs; realm @nick/craft, #377) and the prose fallback failed, with this text.
    error: { type: 'string', description: 'only when the units CLI AND the fallback commands both failed: what failed, the CLI\'s error included (roots then []); absent when either one answered' },
  },
}


/** @type {Schema<UnitFindingsAnswer>} */
export const UNIT_FINDINGS_SCHEMA = /** @type {Schema<UnitFindingsAnswer>} */ (resolveRefs(unitFindingsSchema, UNIT_FINDING_REF))

/** @type {Schema<CoordAnswer>} */
export const COORD_SCHEMA = { type: 'object', additionalProperties: false, required: ['answered', 'unanswered', 'notes'], properties: { answered: { type: 'number' }, unanswered: { type: 'number' }, notes: { type: 'string' } } }


/** @type {Schema<SeamAnswer>} */
export const SEAM_SCHEMA = /** @type {Schema<SeamAnswer>} */ (resolveRefs(seamSchema, UNIT_FINDING_REF))

/** @type {Schema<StopAnswer>} */
export const STOP_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean', description: 'true when ls printed the stop file' } } }
