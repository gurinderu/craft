// The finder lenses of the adversarial review (src/adversarial-review.js), their briefs read from content/: the files
// the Rust CLI's general profile reads too (content/profiles/general.json), so both review with one catalog while the
// engine lives (realm @nick/craft, node #421).
import { contentText } from './content.mjs'
import correctness from '../content/prompts/lens-briefs/general-correctness.md'
import security from '../content/prompts/lens-briefs/general-security.md'
import money from '../content/prompts/lens-briefs/general-money.md'
import concurrency from '../content/prompts/lens-briefs/general-concurrency.md'
import errors from '../content/prompts/lens-briefs/general-errors.md'
import performance from '../content/prompts/lens-briefs/general-performance.md'
import complexity from '../content/prompts/lens-briefs/general-complexity.md'

// The catalog in the engine's order. The complexity lens's prompt is the engine's own; its brief is the CLI's.
/** @type {Record<string, string>} */
export const LENS_BRIEF = {
  correctness: contentText(correctness),
  security: contentText(security),
  money: contentText(money),
  concurrency: contentText(concurrency),
  errors: contentText(errors),
  performance: contentText(performance),
  complexity: contentText(complexity),
}
