// The complexity bars every function craft lints is held to, one definition for both paths: `npm run lint`
// (eslint.config.mjs) and the engines' own code (lib/engine-lint.mjs). Fixed bars, not fitted to the code:
// ESLint's cyclomatic `complexity` (classic count) at 10, and Sonar's cognitive complexity at its standard 15
// (`sonarjs/cognitive-complexity`, from eslint-plugin-sonarjs, registered under the `sonarjs` prefix)
// (realm @nick/craft, #155).

/** @type {Record<string, ['error', number]>} */
export const COMPLEXITY_RULES = {
  complexity: ['error', 10],
  'sonarjs/cognitive-complexity': ['error', 15],
}
