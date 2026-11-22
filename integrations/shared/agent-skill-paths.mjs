// A plugin agent sees the skill listing and can load a skill only when its `tools` hold `Skill`;
// `${CLAUDE_PLUGIN_ROOT}` in its body is substituted (Claude Code 2.1.319, observed in the binary). So
// an agent without `Skill` that is told to "load the rust-review skill" never reads its rubric. Each
// skill such a body names must be named by its file, and every plugin path the body names must exist
// (realm @nick/craft, node #599).
import fs from 'node:fs'
import path from 'node:path'

const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}/'

/** @param {string} tools  the frontmatter `tools` value, a list or a comma string */
export const hasSkillTool = tools => /(^|[^A-Za-z])Skill([^A-Za-z]|$)/.test(tools)

/**
 * The skills of `skills` a body names: `craft:<s>`, `<s>` (backticked or bare) followed by "skill", or a
 * backticked `<s>` alone — a list of skills ("the domain skills (`nix-flakes`, `nixos`)") names each.
 * @param {string} body @param {Iterable<string>} skills @returns {string[]}
 */
export function namedSkills(body, skills) {
  return [...skills]
    .filter(s => {
      const esc = s.replace(/[-]/g, '\\-')
      return new RegExp(`craft:${esc}(?![a-z0-9-])|(?<![a-z0-9-])\`?${esc}\`?(?:'s)? skill|\`${esc}\``).test(body)
    })
    .sort()
}

/**
 * Every literal `${CLAUDE_PLUGIN_ROOT}/<path>` in a body, templates (`<name>`) left out.
 * @param {string} body @returns {string[]}
 */
export function pluginPaths(body) {
  /** @type {Set<string>} */
  const out = new Set()
  for (const m of body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`'"),]+)/g)) {
    const rel = /** @type {string} */ (m[1])
    if (!rel.includes('<')) out.add(rel)
  }
  return [...out].sort()
}

/**
 * Why an agent without the Skill tool cannot reach the skills its body names; empty when it can.
 * @param {string} body  the agent file's body, frontmatter stripped
 * @param {string} tools  its `tools` value
 * @param {Iterable<string>} skills  the skills the plugin ships
 * @param {string[]} pluginRoots  where a plugin path may be: the Claude Code delivery, then the checkout
 *   root, whose `skills/` the delivery links (an installed copy holds both under one root)
 * @returns {string[]}
 */
export function skillAccessProblems(body, tools, skills, pluginRoots) {
  const named = pluginPaths(body)
  const missing = named
    .filter(rel => !pluginRoots.some(root => fs.existsSync(path.join(root, rel))))
    .map(rel => `${ROOT_VAR}${rel} does not exist in the plugin`)
  if (hasSkillTool(tools)) return missing
  const unreached = namedSkills(body, skills)
    .filter(s => !named.includes(`skills/${s}/SKILL.md`))
    .map(s => `names the ${s} skill but has no Skill tool and no ${ROOT_VAR}skills/${s}/SKILL.md path`)
  return [...missing, ...unreached]
}
