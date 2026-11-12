// The OpenCode 2.x package's npm-shrinkwrap.json (realm @nick/craft, node #515): the plugin's lockfile
// (integrations/opencode/plugin/package-lock.json) cut to its production closure and re-rooted at the package. A
// dependency's package.json `overrides` are ignored by npm, so the security pins the plugin holds there (toml, zod;
// #124, #141) reach a consumer only through a lockfile the package carries — and npm reads a package's own
// npm-shrinkwrap.json, never its package-lock.json.
import { parseJsonObject } from './json-object.mjs'

/** @typedef {{ dev?: boolean, [field: string]: unknown }} LockEntry */

/**
 * The shrinkwrap of `lockText` (a lockfileVersion 3 package-lock.json) for the package `name`@`version`: every
 * non-dev entry under node_modules/ as the lockfile has it, and a root that names `dependencies`, which must be the
 * lockfile root's own — so the shrinkwrap never pins a closure other than the one it was locked for.
 * @param {string} lockText @param {string} name @param {string} version @param {Record<string, string>} dependencies
 * @returns {Record<string, unknown>}
 */
export function shrinkwrapOf(lockText, name, version, dependencies) {
  /** @type {{ lockfileVersion?: unknown, packages?: Record<string, LockEntry> }} */
  const lock = parseJsonObject(lockText)
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('the plugin lockfile is not lockfileVersion 3')
  const locked = JSON.stringify(lock.packages['']?.['dependencies'] ?? {})
  if (locked !== JSON.stringify(dependencies)) throw new Error(`the plugin lockfile locks ${locked}, not the package's dependencies`)
  const prod = Object.entries(lock.packages).filter(([key, entry]) => key.startsWith('node_modules/') && entry.dev !== true)
  return {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version, license: 'MIT', dependencies }, ...Object.fromEntries(prod) },
  }
}
