// A Helm chart's own manifest, Chart.yaml (realm @nick/craft, node #435): the chart's application at `appVersion`,
// its source repository from `sources:` when that names an https URL, and each entry of `dependencies:` at its
// `version` — a chart's version, which the upstream's tag may not follow, so the candidate says so. Pure.
import { keyLine, pairPattern, siblingValue, VERSION_CAPTURE } from './manifest-lines.mjs'

/** @typedef {import('./manifest-images.mjs').RawCandidate} RawCandidate */

/** The top-level value of `key`, '' when absent. @param {string[]} lines @param {string} key */
const topValue = (lines, key) => lines.map(keyLine).find(k => k && k.col === 0 && k.key === key)?.value ?? ''

/** The index of the top-level `key:` line, -1 when absent. @param {string[]} lines @param {string} key */
const topIndex = (lines, key) =>
  lines.findIndex(l => {
    const k = keyLine(l)
    return !!k && k.col === 0 && k.key === key
  })

/** The index past the top-level section whose key line is `at`: the next line that starts with a key. @param {string[]} lines @param {number} at */
function sectionEnd(lines, at) {
  const j = lines.findIndex((l, n) => n > at && /^[^\s-]/.test(l))
  return j < 0 ? lines.length : j
}

/** The lines of the top-level section `key`, without its key line; none when absent. @param {string[]} lines @param {string} key */
function section(lines, key) {
  const at = topIndex(lines, key)
  return at < 0 ? [] : lines.slice(at + 1, sectionEnd(lines, at)).map((l, n) => ({ l, j: at + 1 + n }))
}

/** The first https URL listed under the top-level `sources:`. @param {string[]} lines */
function firstSource(lines) {
  const hit = section(lines, 'sources')
    .map(({ l }) => /^[ \t]*-[ \t]+["']?(https:\/\/[^"'\s#]+)["']?[ \t\r]*(?:#.*)?$/.exec(l))
    .find(Boolean)
  return hit ? String(hit[1]) : ''
}

/**
 * The chart's application — only when the chart names its `sources:`: a chart without them is the repository's own
 * application, not an external system (realm @nick/craft, node #435). @param {string[]} lines @returns {RawCandidate[]}
 */
function application(lines) {
  const [name, version] = [topValue(lines, 'name'), topValue(lines, 'appVersion')]
  if (!name || !version || !section(lines, 'sources').some(({ l }) => /^[ \t]*-[ \t]+\S/.test(l))) return []
  return [{ system: name, repo: firstSource(lines), repoGuessed: false, version, versionMatch: `^appVersion:[ \\t]*${VERSION_CAPTURE}` }]
}

/** A `dependencies:` entry at line `j` with a `name` and a `version`, null otherwise. @param {string[]} lines @param {number} j @returns {RawCandidate | null} */
function dependency(lines, j) {
  const k = keyLine(String(lines[j]))
  const v = k && k.dash && k.key === 'name' && k.value ? siblingValue(lines, j, 'version') : null
  if (!k || !v) return null
  return {
    system: k.value,
    repo: '',
    repoGuessed: false,
    version: v.value,
    versionMatch: pairPattern(lines, j, v.j, 'version'),
    note: "a chart dependency's version — the upstream tag may differ",
  }
}

/** Each `dependencies:` entry with a `name` and a `version`. @param {string[]} lines @returns {RawCandidate[]} */
const dependencies = lines => section(lines, 'dependencies').flatMap(({ j }) => dependency(lines, j) ?? [])

/** The raw candidates of a Chart.yaml. @param {string[]} lines */
export const chartCandidates = lines => [...application(lines), ...dependencies(lines)]
