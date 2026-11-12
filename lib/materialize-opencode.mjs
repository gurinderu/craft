// The OpenCode 2.x package of one release (lib/opencode-package.mjs; realm @nick/craft, node #515), committed as the next
// commit of a branch of its own (`opencode-plugin`) and tagged `opencode-v<version>`: the ref a consumer's
// `opencode plugin add git+https://github.com/gurinderu/craft#opencode-v<version>` names.
//
// Run: node lib/materialize-opencode.mjs --branch <name> --message <text>
//   in a clean checkout of a release tag (.github/workflows/opencode-plugin.yml): lays out the package, commits it on
//   refs/heads/<name> (lib/materialize-claude-code.mjs's commitBranch; an unchanged tree commits nothing), tags that
//   commit refs/tags/opencode-v<version> (the version is release-please's manifest's), and prints both. A tag already
//   at that commit is kept; one elsewhere is refused. Pushing the branch and the tag is the caller's.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitBranch, must, parseArgs, spawnGit } from './materialize-claude-code.mjs'
import { layPackage, releaseVersion } from './opencode-package.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TAG_PREFIX = 'opencode-v'
const USAGE = 'usage: materialize-opencode --branch <name> --message <text>'

/**
 * `tag` set to `commit` in `root`'s repository, or left there when it already is.
 * @param {import('./materialize-claude-code.mjs').Git} git @param {string} root @param {string} tag @param {string} commit
 */
function tagAt(git, root, tag, commit) {
  const ref = `refs/tags/${tag}`
  const now = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root })
  if (now.status === 0) {
    if (now.stdout.trim() !== commit) throw new Error(`tag ${tag} already names ${now.stdout.trim()}, not ${commit}`)
    return
  }
  must(git, ['update-ref', ref, commit, '0'.repeat(commit.length)], { cwd: root })
}

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} _env  unused: git inherits the process environment
 * @param {{ root?: string, git?: import('./materialize-claude-code.mjs').Git }} [deps]  injected by tests
 * @returns {import('./script-main.mjs').ScriptResult}
 */
export function run(argv, _env, { root = ROOT, git = spawnGit } = {}) {
  const o = outputLines()
  try {
    const { branch, message } = parseArgs(argv, USAGE)
    const tag = `${TAG_PREFIX}${releaseVersion(root)}`
    const { commit, changed } = commitBranch({ root, branch, message, git, lay: layPackage })
    tagAt(git, root, tag, commit)
    o.stdout.push(`materialize-opencode: ${branch} ${changed ? 'at' : 'unchanged at'} ${commit}, tagged ${tag}`)
    return { exitCode: 0, ...o }
  } catch (e) {
    o.stderr.push(`materialize-opencode: ${e instanceof Error ? e.message : String(e)}`)
    return { exitCode: 1, ...o }
  }
}

await runIfMain(import.meta.url, run)
