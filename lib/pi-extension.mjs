// craft's pi extension (the package's `pi.extensions`): the `craft_review` tool, craft's review by the craft binary
// with its pi backend (realm @nick/craft, nodes #499, #504) — run through lib/craft-review-run.mjs, its progress
// streamed through `onUpdate` while it runs, its verdict, findings and report drawn by `renderResult`. In print and
// JSON mode (no UI) the tool answers in plain text only. pi supplies @earendil-works/pi-tui to the extensions it loads;
// the surface used here is pinned in lib/pi-tui.d.ts.
import { Text } from '@earendil-works/pi-tui'
import { answerText, flagWords, progressLine, runReview, summaryOf } from './craft-review-run.mjs'

/** @typedef {import('./craft-review-run.mjs').Progress} Progress */
/** @typedef {import('./craft-review-run.mjs').Summary} Summary */
/** @typedef {{ progress: Progress, summary: Summary | null }} Details */
/** @typedef {{ content: { type: 'text', text: string }[], details: Details, isError?: boolean }} ToolResult */
/** @typedef {{ cwd: string, hasUI: boolean }} ToolContext */
/** @typedef {{ fg(color: string, text: string): string, bold(text: string): string }} Theme */
/**
 * @typedef {{
 *   name: string, label: string, description: string, promptSnippet: string, parameters: object,
 *   execute(id: string, params: { args?: string }, signal: AbortSignal | undefined, onUpdate: ((r: ToolResult) => void) | undefined, ctx: ToolContext): Promise<ToolResult>,
 *   renderResult(result: ToolResult, options: { isPartial: boolean, expanded: boolean }, theme: Theme): Text,
 * }} ToolDefinition
 */
/** @typedef {{ registerTool(tool: ToolDefinition): void }} ExtensionAPI */

const DESCRIPTION =
  "craft's review of the current change (the mechanical gate, review lenses per language profile, verification, one report and an Approve/Warning/Block verdict), each review agent its own `pi -p` process; it runs long. `args`: the review's flags as one string, for example `--base main --depth light`, `--base <commit> --fresh --full-every 0` (re-review of fix commits), `--run <dir>` (resume), `--models <model>`, `--thinking <level>`, `--no-gate`, `--pr <n> --comment`."

const PARAMETERS = {
  type: 'object',
  properties: { args: { type: 'string', description: "The review's flags, as on the `craft review run` command line; none for the defaults." } },
  additionalProperties: false,
}

const SHOWN = 8

/** The verdict line's colour. @param {string} verdict */
const tone = verdict => (verdict.startsWith('Approve') && !verdict.includes('INCOMPLETE') ? 'success' : verdict.startsWith('Block') ? 'error' : 'warning')

/** The ended run as lines: verdict, findings (all when expanded), report. @param {Summary} s @param {boolean} expanded @param {Theme} theme */
export function summaryLines(s, expanded, theme) {
  const shown = expanded ? s.findings : s.findings.slice(0, SHOWN)
  const more = s.findings.length - shown.length
  return [
    theme.fg(tone(s.verdict), theme.bold(s.verdict)),
    ...(s.findings.length ? shown.map(f => theme.fg('muted', f)) : [theme.fg('muted', 'No findings.')]),
    ...(more > 0 ? [theme.fg('dim', `… ${more} more`)] : []),
    ...(s.report ? [theme.fg('dim', `report: ${s.report}`)] : []),
  ]
}

/** @param {ExtensionAPI} pi */
export default function craftReview(pi) {
  pi.registerTool({
    name: 'craft_review',
    label: 'craft review',
    description: DESCRIPTION,
    promptSnippet: "Run craft's review of the current change and report its verdict",
    parameters: PARAMETERS,
    async execute(_id, params, signal, onUpdate, ctx) {
      const update =
        ctx.hasUI && onUpdate
          ? (/** @type {Progress} */ progress) => onUpdate({ content: [{ type: 'text', text: progressLine(progress) }], details: { progress, summary: null } })
          : undefined
      const outcome = await runReview({
        backend: 'pi',
        args: flagWords(params.args ?? ''),
        cwd: ctx.cwd,
        ...(signal ? { signal } : {}),
        ...(update ? { onProgress: update } : {}),
      })
      const summary = outcome.result ? summaryOf(outcome) : null
      return { content: [{ type: 'text', text: answerText(outcome) }], details: { progress: outcome.progress, summary }, ...(summary ? {} : { isError: true }) }
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const details = /** @type {Details | undefined} */ (result.details)
      if (details?.summary && !isPartial) return new Text(summaryLines(details.summary, expanded, theme).join('\n'), 0, 0)
      return new Text(theme.fg('dim', isPartial && details ? progressLine(details.progress) : (result.content[0]?.text ?? '')), 0, 0)
    },
  })
}
