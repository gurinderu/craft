// Known mechanical relocations (realm @nick/craft, nodes #562, #167).
import fs from 'node:fs'
import path from 'node:path'

/** A checkout's own path, including a checkout predating the relocation. @param {string} root @param {string} current @param {string} legacy */
export function layoutPath(root, current, legacy) {
  return fs.existsSync(path.join(root, current)) ? current : legacy
}

/** Stable identities for comparisons across the relocation, not arbitrary path aliases. @param {string} value */
export function historicalIdentity(value) {
  return value
    .replace(/^integrations\/shared\/(?!config\/|fixtures\/)/, 'lib/')
    .replace(/^integrations\/pi\/(pi-extension(?:\.test)?\.mjs|pi-tui\.d\.ts)/, 'lib/$1')
    .replace(/^integrations\/claude-code\/src\//, 'src/')
}

/** Mutation scopes in the canonical layout: the old broad include also included pi. @param {string[]} globs */
export function mutationScope(globs) {
  return globs.flatMap(g => {
    if (g === 'lib/**/*.mjs') {
      return ['integrations/shared/**/*.mjs', 'integrations/pi/pi-extension.mjs', '!integrations/shared/config/**', '!integrations/shared/fixtures/**']
    }
    return [g.replace(/^(!?)lib\//, '$1integrations/shared/')]
  })
}
