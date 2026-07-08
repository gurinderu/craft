export const meta = {
  name: 'nix-review',
  description: 'Nix-pinned entry to the generic review engine — reviews only the Nix files in a diff. Prefer `review` (auto-detects language); use this to force a Nix-only pass.',
  whenToUse: 'Explicit Nix-only diff review; the generic default is `review`. Same args as `review` (base, intent, comment, path, strict).',
  phases: [{ title: 'Review', detail: 'delegates to the review engine pinned to the nix profile' }],
}

// Thin pin over the generic engine (review.js holds the engine + PROFILES registry). Invoked only as
// a root (humans/agents), so it never nests (workflow() nesting is one level only).
return await workflow('review', { ...(args && typeof args === 'object' ? args : {}), languages: ['nix'] })
