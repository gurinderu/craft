// triage-findings' prompts and answer schemas as content (content/prompts/triage-*.md, content/schemas/triage-*.schema.json;
// integrations/shared/content.mjs, realm @nick/craft, node #452), so the craft binary renders the same text when it takes the
// triage over (node #616). What is computed — a line present or not, a value's default, a block as JSON — is computed here.
// Imported by integrations/claude-code/src/triage-findings.js.
import { render } from './content.mjs'
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'
import gatherReportTpl from '../../content/prompts/triage-gather-report.md'
import gatherPrTpl from '../../content/prompts/triage-gather-pr.md'
import validateTpl from '../../content/prompts/triage-validate.md'
import validateFixTpl from '../../content/prompts/triage-validate-fix.md'
import validateMemoryTpl from '../../content/prompts/triage-validate-memory.md'
import planTpl from '../../content/prompts/triage-plan.md'
import rawSchema from '../../content/schemas/triage-raw.schema.json' with { type: 'json' }
import validationSchema from '../../content/schemas/triage-validation.schema.json' with { type: 'json' }
import planSchema from '../../content/schemas/triage-plan.schema.json' with { type: 'json' }

// The gatherers' answer: one source's findings.
export const RAW_SCHEMA = rawSchema
// One validator's verdict on one finding.
export const VALIDATION_SCHEMA = validationSchema
// The plan agent's answer: the plan, the ledger, the summary.
export const PLAN_SCHEMA = planSchema

/** The report gatherer's prompt. @param {string} report the report file's path @returns {string} */
export const gatherReportPrompt = report => render(gatherReportTpl, { report })

/** The PR gatherer's prompt. @param {string} pr the PR number @returns {string} */
export const gatherPrPrompt = pr => render(gatherPrTpl, { pr })

/**
 * One validator's prompt: the finding, its memory note when a record matched it without settling it, the pin and
 * where class 1 must be shown.
 * @param {{ source: unknown, severity: unknown, location: unknown, title: unknown, detail: unknown, proposed_fix: unknown }} f  read as text, as a template
 *   literal reads it
 * @param {{ id: string, pin: string, classOneBase: string, memoryNote: string }} at
 * @returns {string}
 */
export function validatePrompt(f, { id, pin, classOneBase, memoryNote }) {
  return render(validateTpl, {
    pin,
    source: String(f.source),
    severity: String(f.severity),
    location: String(f.location || '(none given)'),
    title: String(f.title),
    detail: String(f.detail),
    proposedFixLine: f.proposed_fix ? render(validateFixTpl, { proposedFix: String(f.proposed_fix) }) : '',
    memoryNoteLine: memoryNote ? render(validateMemoryTpl, { memoryNote }) : '',
    dependencySourceHow: DEPENDENCY_SOURCE_HOW,
    classOneBase,
    stableId: id,
  })
}

/**
 * The plan agent's prompt: the accepted findings, every verdict, and the rows settled before validation, each as JSON.
 * @param {{ accepted: unknown, validations: unknown, sifted: unknown, unjudgedMarker: string, siftMark: string }} given
 * @returns {string}
 */
export function planPrompt({ accepted, validations, sifted, unjudgedMarker, siftMark }) {
  const json = (/** @type {unknown} */ v) => JSON.stringify(v, null, 2)
  return render(planTpl, { unjudgedMarker, siftMark, accepted: json(accepted), validations: json(validations), sifted: json(sifted) })
}
