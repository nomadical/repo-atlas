// The curated decision log: one append-only line per decision; current state is a replay.

// A decision counts only between the day it was taken and the day it was revoked;
// `asOf` omitted means the latest night.
export const asOfDate = (a, asOf) => {
  if (!a) return null
  const day = asOf || '9999-12-31'
  return (a.at || '') <= day && (!a.revokedAt || day < a.revokedAt) ? a : null
}

// A revoke with no check ends a whole-component exclusion; with a check, that one decision.
// Revoked decisions stay in the projection with `revokedAt`, so asOfDate can keep them alive
// for the nights before the revoke — deleting them would rewrite history in the analytics replay.
// Null-prototype objects: a component named `__proto__` must be a key, not a prototype write.
export function replay(entries) {
  const approved = Object.create(null), notApplicable = Object.create(null), excluded = Object.create(null)
  for (const e of entries) {
    const audit = { ref:e.ref || '', reason:e.reason || '', by:e.author || 'unknown', at:(e.ts || '').slice(0, 10) }
    if (e.type === 'deviation') approved[e.component] = { ...(approved[e.component] || {}), [e.check]:audit }
    else if (e.type === 'not-applicable') notApplicable[e.component] = { ...(notApplicable[e.component] || {}), [e.check]:audit }
    else if (e.type === 'exclusion') excluded[e.component] = audit
    else if (e.type === 'revoke') {
      const at = (e.ts || '').slice(0, 10)
      const mark = (a) => { if (a && !a.revokedAt) a.revokedAt = at }
      if (!e.check) mark(excluded[e.component])
      else { mark((approved[e.component] || {})[e.check]); mark((notApplicable[e.component] || {})[e.check]) }
    }
  }
  return { approved, notApplicable, excluded }
}

export const auditLine = (a) => (a ? [a.ref, a.reason, `${a.by} · ${a.at}`].filter(Boolean).join(' · ') : '')

const TYPES = new Set(['deviation', 'not-applicable', 'exclusion', 'revoke'])

// Append-only, so an oversized field can never be edited out again.
const LIMITS = { component: 200, check: 40, ref: 500, reason: 2000 }

// -> an error string, or null when the body may become an entry.
export function validateEntry(body = {}) {
  if (!TYPES.has(body.type)) return `type must be one of ${[...TYPES].join(', ')}`
  if (typeof body.component !== 'string' || !body.component.trim()) return 'component is required'
  if ((body.type === 'deviation' || body.type === 'not-applicable') && !body.check) return 'check is required'
  if (body.check != null && (typeof body.check !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(body.check))) {
    return 'check must be a short identifier'
  }
  for (const [field, max] of Object.entries(LIMITS)) {
    if (body[field] != null && String(body[field]).length > max) return `${field} must be at most ${max} characters`
  }
  return null
}

// `ts` and `author` are the server's to set — a client could sign or back-date someone else's decision.
export const buildEntry = (body, author) => ({
  ts: new Date().toISOString(),
  type: body.type,
  component: body.component.trim(),
  ...(body.check ? { check: body.check } : {}),
  ...(body.ref ? { ref: String(body.ref).trim() } : {}),
  ...(body.reason && String(body.reason).trim() ? { reason: String(body.reason).trim() } : {}),
  author,
})
