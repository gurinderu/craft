// How an agent finds the source of a dependency it must open to settle a premise: one instruction,
// so no prompt that demands the opening leaves the agent to search blindly or lets a tool re-resolve
// the lockfile. Used by src/triage-findings.js (the validator's premise discipline).
import { contentText } from './content.mjs'
import dependencySourceTpl from '../content/prompts/dependency-source.md'

// The text is content (content/prompts/dependency-source.md, lib/content.mjs, realm @nick/craft, node #452), read alike
// by the Rust CLI's review (cli/crates/craft-review).
export const DEPENDENCY_SOURCE_HOW = contentText(dependencySourceTpl)
