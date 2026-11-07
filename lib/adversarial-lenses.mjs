// The finder lenses of the adversarial review (src/adversarial-review.js), their briefs read from content/: the files
// the Rust CLI's general profile reads too (content/profiles/general.json), so both review with one catalog while the
// engine lives (realm @nick/craft, node #421). The complexity lens is this engine's alone: it runs metrics-or-nothing
// behind an index warm-up and a metric-aware verifier the CLI does not have yet, so its brief stays here.
import { contentText } from './content.mjs'
import correctness from '../content/prompts/lens-briefs/general-correctness.md'
import security from '../content/prompts/lens-briefs/general-security.md'
import money from '../content/prompts/lens-briefs/general-money.md'
import concurrency from '../content/prompts/lens-briefs/general-concurrency.md'
import errors from '../content/prompts/lens-briefs/general-errors.md'
import performance from '../content/prompts/lens-briefs/general-performance.md'

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
