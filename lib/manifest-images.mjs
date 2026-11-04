// Container images as deployment manifests name them (realm @nick/craft, node #435): an `image: <repo>:<tag>` line
// (docker-compose, a plain Kubernetes manifest, a chart's values), a `repository:` with a sibling `tag:` (and
// `registry:`) in a chart's values, and a kustomization's `images:` entry (`name`, `newName`, `newTag`). Each gives
// a raw candidate: the system, the version and the pattern that reads it; an image on ghcr.io suggests its GitHub
// repository, marked guessed. A tag that is a template, `latest` or missing gives none. Pure.
import { keyLine, linePattern, pairPattern, siblingValue } from './manifest-lines.mjs'

/** @typedef {{ system: string, repo: string, repoGuessed: boolean, version: string, versionMatch: string, note?: string }} RawCandidate */

/** The image's name and tag, a digest dropped; null without a usable tag. @param {string} ref */
export function splitImage(ref) {
  const noDigest = ref.replace(/@sha256:[0-9a-f]+$/i, '')
  const colon = noDigest.lastIndexOf(':')
  if (colon <= noDigest.lastIndexOf('/')) return null
  const [name, tag] = [noDigest.slice(0, colon), noDigest.slice(colon + 1)]
  return name && tag && tag !== 'latest' ? { name, tag } : null
}

/** A system's short name: the image's last path segment. @param {string} name */
export const imageSystem = name => name.slice(name.lastIndexOf('/') + 1)

/** The GitHub repository a ghcr.io image suggests, '' for another registry. @param {string} name */
export function guessedRepo(name) {
  const m = /^ghcr\.io\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(name)
  return m ? `https://github.com/${m[1]}/${m[2]}` : ''
}

/** @param {string} name @param {string} tag @param {string} versionMatch @returns {RawCandidate} */
function imageCandidate(name, tag, versionMatch) {
  const repo = guessedRepo(name)
  return { system: imageSystem(name), repo, repoGuessed: !!repo, version: tag, versionMatch, ...(repo ? { note: `repo guessed from the image ${name}` } : {}) }
}

/** Every `image: <repo>:<tag>` line. @param {string[]} lines @returns {RawCandidate[]} */
export function imageLines(lines) {
  return lines.flatMap(line => {
    const k = keyLine(line)
    const img = k && k.key === 'image' && k.value ? splitImage(k.value) : null
    if (!k || !img) return []
    const at = k.rest.indexOf(img.name) + img.name.length + 1
    return [imageCandidate(img.name, img.tag, linePattern(k.rest.slice(0, at)))]
  })
}

/** Every `repository:` with a sibling `tag:` (a sibling `registry:` prefixed to the name), as a chart's values spell an image. @param {string[]} lines @returns {RawCandidate[]} */
export function repositoryTagBlocks(lines) {
  return lines.flatMap((line, i) => {
    const k = keyLine(line)
    const tag = k && k.key === 'repository' && k.value && !k.value.includes(':') ? siblingValue(lines, i, 'tag', { tag: true }) : null
    if (!k || !tag) return []
    const registry = siblingValue(lines, i, 'registry')?.value
    return [imageCandidate(registry ? `${registry}/${k.value}` : k.value, tag.value, pairPattern(lines, i, tag.j, 'tag'))]
  })
}

/** A kustomization's `images:` entries with a `newTag`. @param {string[]} lines @returns {RawCandidate[]} */
export function kustomizeImages(lines) {
  return lines.flatMap((line, i) => {
    const k = keyLine(line)
    const tag = k && k.dash && k.key === 'name' && k.value ? siblingValue(lines, i, 'newTag', { tag: true }) : null
    if (!k || !tag) return []
    const name = siblingValue(lines, i, 'newName')?.value || k.value
    return [imageCandidate(name, tag.value, pairPattern(lines, i, tag.j, 'newTag'))]
  })
}
