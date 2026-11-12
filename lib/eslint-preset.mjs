// The rules of one named entry of a typescript-eslint preset, failing closed (realm @nick/craft, #142): an upgrade
// that renames or drops the entry must stop the lint, not leave it running with none of the preset's rules.

/**
 * @param {readonly { name?: string | undefined, rules?: object | undefined }[]} preset  e.g. `tseslint.configs.strictTypeChecked`
 * @param {string} name  the entry's name, e.g. `typescript-eslint/strict-type-checked`
 * @returns {object}
 */
export function presetRules(preset, name) {
  const rules = preset.find(c => c.name === name)?.rules
  if (!rules || Object.keys(rules).length === 0)
    throw new Error(`eslint.config.mjs: the preset has no entry "${name}" with rules — typescript-eslint renamed or dropped it; update the config`)
  return rules
}
