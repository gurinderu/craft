// A file of the consumer's repository read only inside it (realm @nick/craft, node #430 for the version file the
// sources CLI reads, node #435 for the manifests the discovery CLI reads): the path and its real path both under the
// repository's real root, so no `..` and no symlink leads out, and a size bound.
import fs from 'node:fs'
import path from 'node:path'

/** Whether `p` is `root` or under it. @param {string} root @param {string} p */
export const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * The text of `rel` under the repository's real root `repoReal`; throws, naming `label`, when it resolves outside,
 * is missing, or is not a file of at most `max` bytes.
 * @param {string} repoReal @param {string} rel @param {{ max: number, label: string }} bound
 */
export function readRepoFile(repoReal, rel, { max, label }) {
  const abs = path.resolve(repoReal, rel)
  if (!inside(repoReal, abs)) throw new Error(`${label} resolves outside the repository`)
  /** @type {string} */
  let real
  try {
    real = fs.realpathSync(abs)
  } catch {
    throw new Error(`${label} ${rel} not found`)
  }
  if (!inside(repoReal, real)) throw new Error(`${label} resolves outside the repository`)
  const st = fs.statSync(real)
  if (!st.isFile() || st.size > max) throw new Error(`${label} ${rel} is not a file of at most ${max} bytes`)
  return fs.readFileSync(real, 'utf8')
}
