// What a record put back from its parts takes from its header (realm @nick/craft, node #396): the parts are a
// model's copy like the header, but only the header went through settleEngineRevision (lib/craft-log-run.mjs),
// and only the header declares how long a ledger carried whole was.

// What a live engine never sends: only `recover` and `from-journal` write these, in code. They decide a
// record's fingerprint basis, so in a payload they can only have come from the copy (settleEngineRevision).
export const RECOVERY_ONLY = ['partial', 'phases', 'runEngineRevision']

// The header's revision (or its dispute) stands, a recovery-only field the parts carry is dropped, and parts that
// disagree with the header file the dispute instead of a basis. A warning when they disagreed, '' else.
/** @param {Record<string, unknown>} built @param {Record<string, unknown>} header @returns {string} */
export function settleParts(built, header) {
  const injected = RECOVERY_ONLY.filter(k => Object.prototype.hasOwnProperty.call(built, k))
  for (const k of injected) delete built[k]
  const disputed = header['workflowEngineRevisionDisputed']
  const want = header['workflowEngineRevision'], got = built['workflowEngineRevision']
  if (disputed === undefined && got === want && !injected.length) return ''
  delete built['workflowEngineRevision']
  if (disputed !== undefined) { built['workflowEngineRevisionDisputed'] = disputed; return '' }
  return partsDispute(built, want, got, injected)
}

// The dispute parts that disagree with their header file in place of a basis, and its warning.
/** @param {Record<string, unknown>} built @param {unknown} want @param {unknown} got @param {string[]} injected @returns {string} */
function partsDispute(built, want, got, injected) {
  const also = injected.length ? `, recovery-only ${injected.join(', ')}` : ''
  built['workflowEngineRevisionDisputed'] = { argv: want === undefined ? null : String(want), payload: got ?? null, ...(injected.length ? { injected } : {}) }
  return `craft-log-run WARNING: the record's parts disagree with its header (revision ${JSON.stringify(want ?? null)} in the header, ${JSON.stringify(got ?? null)} in the parts${also}) — filed with no fingerprint basis`
}

// A short record's ledger, when the record carried it whole and the parts that came back hold less: the
// declared length goes where the prior-round reader takes a short shard set's (`ledgerInShards.total`,
// ledgerCountOf), so the next round reads the ledger as truncated, never as a short round (#245).
/** @param {Record<string, unknown>} record @param {{ ledger?: number }} decl @returns {Record<string, unknown>} */
export function markShortLedger(record, decl) {
  if (decl.ledger === undefined) return record
  const ledger = Array.isArray(record['ledger']) ? record['ledger'] : []
  return ledger.length >= decl.ledger ? record : { ...record, ledger, ledgerInShards: { of: 0, total: decl.ledger, seen: 0 } }
}
