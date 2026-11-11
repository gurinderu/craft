// A whole HTTP(S) response body by GET, redirects followed (GitHub's release downloads redirect to a storage host),
// never from https down to http, capped in size and time. Node built-ins only: lib/craft-bin.mjs ships (realm @nick/craft, #124).
import http from 'node:http'
import https from 'node:https'

const MAX_REDIRECTS = 5
const MAX_BYTES = 256 * 1024 * 1024
const TIMEOUT_MS = 60_000

/** A response that was neither a redirect nor 200, with its status. */
export class HttpError extends Error {
  /** @param {number} status @param {string} url */
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`)
    this.status = status
  }
}

/**
 * Whether another path to the same file may succeed: a 5xx, a 429, or a network error or timeout (a Node error code).
 * Any other 4xx, a redirect loop or an oversized body is the file itself and is not.
 * @param {unknown} e
 */
export function isTransient(e) {
  if (e instanceof HttpError) return e.status >= 500 || e.status === 429
  return e instanceof Error && typeof (/** @type {{ code?: unknown }} */ (e).code) === 'string'
}

// The headers meant for the origin asked only: a token, and GitHub's API version, which a storage host is not.
const ORIGIN_ONLY = ['authorization', 'x-github-api-version']

/**
 * The headers a redirect from `from` to `to` carries on: all of them on the same origin, all but the
 * origin-only ones elsewhere — a token never reaches a host it was not meant for.
 * @param {Record<string, string>} headers @param {URL} from @param {URL} to
 */
function headersAcross(headers, from, to) {
  if (from.origin === to.origin) return headers
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !ORIGIN_ONLY.includes(k.toLowerCase())))
}

/**
 * The body at `url`, following redirects; https never turns into http on the way.
 * @param {string} url @param {{ headers?: Record<string, string>, hops?: number }} [o] @returns {Promise<Buffer>}
 */
export function download(url, { headers = {}, hops = 0 } = {}) {
  const u = new URL(url)
  const client = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null
  if (!client) return Promise.reject(new Error(`not an http(s) URL: ${url}`))
  return new Promise((resolve, reject) => {
    const req = client.get(u, { timeout: TIMEOUT_MS, headers }, res => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        res.resume()
        const next = new URL(location, u)
        if (hops >= MAX_REDIRECTS) return reject(new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`))
        if (u.protocol === 'https:' && next.protocol !== 'https:') return reject(new Error(`refused a redirect from https to ${next.protocol} at ${url}`))
        return resolve(download(next.href, { headers: headersAcross(headers, u, next), hops: hops + 1 }))
      }
      if (status !== 200) {
        res.resume()
        return reject(new HttpError(status, url))
      }
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      res.on('data', (/** @type {Buffer} */ c) => {
        size += c.length
        if (size > MAX_BYTES) {
          req.destroy(new Error(`${url} is over ${MAX_BYTES} bytes`))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out fetching ${url}`), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
  })
}
