// The finder lenses of the adversarial review (src/adversarial-review.js), their briefs read from content/: the files
// the Rust CLI's general profile reads too (content/profiles/general.json), so both review with one catalog while the
// engine lives (realm @nick/craft, node #421). The complexity lens is metrics-or-nothing (realm @nick/craft, node #421):
// it runs only behind the code-metrics index the warm-up finds, and its findings go to a verifier that re-reads the
// metrics — the lens prompt, the warm-up and that verifier's instruction are content the CLI renders too.
import { contentText, render } from './content.mjs'
import correctness from '../content/prompts/lens-briefs/general-correctness.md'
import security from '../content/prompts/lens-briefs/general-security.md'
import money from '../content/prompts/lens-briefs/general-money.md'
import concurrency from '../content/prompts/lens-briefs/general-concurrency.md'
import errors from '../content/prompts/lens-briefs/general-errors.md'
import performance from '../content/prompts/lens-briefs/general-performance.md'
import complexityTpl from '../content/prompts/lens-complexity.md'
import verifyMetric from '../content/prompts/verify-metric.md'
import indexWarmup from '../content/prompts/index-warmup.md'

/** The lenses the CLI's general profile shares, in the engine's order. @type {Record<string, string>} */
export const SHARED_LENS_BRIEF = {
  correctness: contentText(correctness),
  security: contentText(security),
  money: contentText(money),
  concurrency: contentText(concurrency),
  errors: contentText(errors),
  performance: contentText(performance),
}

/** The engine's whole catalog: the shared lenses, then complexity. @type {Record<string, string>} */
export const LENS_BRIEF = {
  ...SHARED_LENS_BRIEF,
  complexity: 'complexity metrics from the codebase-memory graph (metrics-or-nothing; skipped when the repo is not indexed).',
}

/** The complexity lens's prompt over the diff from `base`, as the reader is told it. @param {string} base */
export const complexityPrompt = base => render(complexityTpl, { base })

/** The instruction of the verifier of a complexity finding: it re-reads the metrics. */
export const METRIC_VERIFY = contentText(verifyMetric)

/** The index warm-up's prompt. */
export const INDEX_WARMUP = contentText(indexWarmup)
