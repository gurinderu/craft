export const meta = {
  name: 'rust-review',
  description: 'Rust-pinned entry to the generic review engine — reviews only the Rust files in a diff. Prefer `review` (auto-detects language); use this to force a Rust-only pass.',
  whenToUse: 'Explicit Rust-only diff review; the generic default is `review`. Same args as `review` (base, intent, comment, path, strict).',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the rust profile' }],
}

// Thin pin over the generic engine. review.js holds the engine + PROFILES registry; this just
// restricts it to the rust profile. Invoked only as a root (humans/agents) — rust-audit calls
// `review` directly, so this never nests (workflow() nesting is one level only).
return await workflow('review', { ...(args && typeof args === 'object' ? args : {}), languages: ['rust'] })
