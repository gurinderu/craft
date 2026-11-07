// A nested finding's file, spelled as the files the nested run was handed are (realm @nick/craft, node #420): the
// critic may write `./web/app.js`, `/work/wt/web/app.js` or `web/app.js:12:3` for the same handed file. No
// node:path — the engines bundle this module and their sandbox has no Node built-ins.

/** @param {string} p @returns {string} the path without trailing slashes */
const trimmed = p => p.replace(/\/+$/, '')

/**
 * The repo-relative path a finding's `file` names: a leading `./` and a trailing `:<line>[:<col>]` stripped, an
 * absolute path made relative to the first root it sits under. An absolute path under no root that ends in
 * `/<handed file>` is read as that file: the sandbox does not know the session's directory, which may be another
 * checkout of the same repo.
 * @param {unknown} file @param {string[]} roots @param {Set<string>} [handed] @returns {string}
 */
export function findingPath(file, roots, handed = new Set()) {
  const p = String(file ?? '').replace(/:\d+(?::\d+)?$/, '').replace(/^(?:\.\/)+/, '')
  if (!p.startsWith('/')) return p
  for (const root of roots.map(trimmed).filter(Boolean)) {
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1)
  }
  return [...handed].find(h => p.endsWith(`/${h}`)) ?? p
}
