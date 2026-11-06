// A whole HTTP(S) response body by GET, redirects followed (GitHub's release downloads redirect to a storage host),
// never from https down to http, capped in size and time. Node built-ins only: lib/craft-bin.mjs ships (realm @nick/craft, #124).
import http from 'node:http'
import https from 'node:https'

const MAX_REDIRECTS = 5
const MAX_BYTES = 256 * 1024 * 1024
const TIMEOUT_MS = 60_000

/**
 * The body at `url`, following redirects; https never turns into http on the way.
 * @param {string} url @param {number} [hops] @returns {Promise<Buffer>}
 */
export function download(url, hops = 0) {
  const u = new URL(url)
  const client = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null
  if (!client) return Promise.reject(new Error(`not an http(s) URL: ${url}`))
  return new Promise((resolve, reject) => {
    const req = client.get(u, { timeout: TIMEOUT_MS }, res => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        res.resume()
        const next = new URL(location, u)
        if (hops >= MAX_REDIRECTS) return reject(new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`))
        if (u.protocol === 'https:' && next.protocol !== 'https:') return reject(new Error(`refused a redirect from https to ${next.protocol} at ${url}`))
        return resolve(download(next.href, hops + 1))
      }
      if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status} for ${url}`)) }
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      res.on('data', (/** @type {Buffer} */ c) => {
        size += c.length
        if (size > MAX_BYTES) { req.destroy(new Error(`${url} is over ${MAX_BYTES} bytes`)); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timed out fetching ${url}`)))
    req.on('error', reject)
  })
}
