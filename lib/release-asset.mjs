// A GitHub release's asset by name: its browser download URL first, and when that fails transiently (a 5xx, a 429,
// a network error, a timeout) once more through the REST release assets — github.com's edge answered 504 for a
// release's downloads while the API's asset endpoint served the same files (the fallback: realm @nick/craft,
// node #457; the REST surface: node #490). Any other 4xx is the asset really missing and is not tried again. The API
// allows 60 requests an hour per IP without a token, so the release is read once for all its assets; a token goes as
// a bearer to the API's own origin only, and a 401 or 403 to it is asked once more without it: the release is
// public, and the token in the environment may be another forge's or expired (#457).
import { download, HttpError, isTransient } from './http-download.mjs'

export const API_BASE = 'https://api.github.com'

/** @param {unknown} e */
const message = e => (e instanceof Error ? e.message : String(e))

/** A refusal of the credentials rather than of the file. @param {unknown} e */
const refused = e => e instanceof HttpError && (e.status === 401 || e.status === 403)

/** The release's assets as the API lists them, those with a string name and url. @param {Buffer} body */
function assetsIn(body) {
  const assets = /** @type {{ assets?: unknown }} */ (JSON.parse(body.toString('utf8'))).assets
  if (!Array.isArray(assets)) return []
  return /** @type {{ name: string, url: string }[]} */ (assets.filter(a => typeof a?.name === 'string' && typeof a?.url === 'string'))
}

/**
 * A fetcher of the release's assets by name.
 * @param {{ base: string, repo: string, version: string, apiBase?: string | undefined, token?: string | undefined }} release
 *   `base` the browser download directory; `repo` owner/name; `token` sent to `apiBase` only
 * @returns {(name: string) => Promise<Buffer>}
 */
export function releaseAssets({ base, repo, version, apiBase = API_BASE, token = '' }) {
  const tagUrl = `${apiBase}/repos/${repo}/releases/tags/v${version}`
  const apiOrigin = new URL(apiBase).origin
  /** `url` from the API: with the token when it is the API's origin, and anonymously once if the token is refused.
   * @param {string} url @param {string} accept */
  const fromApi = async (url, accept) => {
    const headers = { 'user-agent': 'craft-bin', accept }
    if (!token || new URL(url).origin !== apiOrigin) return download(url, { headers })
    try {
      return await download(url, { headers: { ...headers, authorization: `Bearer ${token}` } })
    } catch (withToken) {
      if (!refused(withToken)) throw withToken
      try { return await download(url, { headers }) } catch (without) {
        throw new Error(`with the token: ${message(withToken)}; without it: ${message(without)}`)
      }
    }
  }
  /** @type {Promise<{ name: string, url: string }[]> | undefined} */
  let listing
  /** @param {string} name */
  const throughApi = async name => {
    listing ??= fromApi(tagUrl, 'application/vnd.github+json').then(assetsIn)
    const asset = (await listing).find(a => a.name === name)
    if (!asset) throw new Error(`release v${version} of ${repo} has no asset ${name} (${tagUrl})`)
    return fromApi(asset.url, 'application/octet-stream')
  }
  return async name => {
    try {
      return await download(`${base}/${name}`)
    } catch (first) {
      if (!isTransient(first)) throw first
      try { return await throughApi(name) } catch (second) {
        throw new Error(`${message(first)}; then through the API: ${message(second)}`)
      }
    }
  }
}
