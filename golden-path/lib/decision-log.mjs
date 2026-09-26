// The curated decision log: one append-only line per decision; current state is a replay.

const LATEST_NIGHT = '9999-12-31'

// A decision counts only between the day it was taken and the day it was revoked;
// `asOf` omitted means the latest night.
export const asOfDate = (audit, asOf) => {
  if (!audit) return null
  const day = asOf || LATEST_NIGHT
  const taken = (audit.at || '') <= day
  const notYetRevoked = !audit.revokedAt || day < audit.revokedAt
  return taken && notYetRevoked ? audit : null
}

const dayOf = (entry) => (entry.ts || '').slice(0, 10)

function auditOf(entry) {
  return {
    ref: entry.ref || '',
    reason: entry.reason || '',
    by: entry.author || 'unknown',
    at: dayOf(entry),
  }
}

// Replaces the component's per-check map rather than mutating it.
function recordCheckDecision(byComponent, entry, audit) {
  const checks = Object.assign(Object.create(null), byComponent[entry.component])
  checks[entry.check] = audit
  byComponent[entry.component] = checks
}

// Own keys only: a check named `constructor` must not find Object.prototype.constructor.
function checkDecision(byComponent, component, check) {
  const checks = byComponent[component]
  return checks && Object.hasOwn(checks, check) ? checks[check] : undefined
}

function markRevoked(audit, day) {
  if (audit && !audit.revokedAt) audit.revokedAt = day
}

// A revoke with no check ends a whole-component exclusion; with a check, that one decision.
// Revoked decisions stay in the projection with `revokedAt`, so asOfDate can keep them alive
// for the nights before the revoke — deleting them would rewrite history in the analytics replay.
// Null-prototype objects: a component named `__proto__` must be a key, not a prototype write.
export function replay(entries) {
  const approved = Object.create(null)
  const notApplicable = Object.create(null)
  const excluded = Object.create(null)
  for (const entry of entries) {
    const audit = auditOf(entry)
    if (entry.type === 'deviation') {
      recordCheckDecision(approved, entry, audit)
    } else if (entry.type === 'not-applicable') {
      recordCheckDecision(notApplicable, entry, audit)
    } else if (entry.type === 'exclusion') {
      excluded[entry.component] = audit
    } else if (entry.type === 'revoke') {
      const day = dayOf(entry)
      if (!entry.check) {
        markRevoked(excluded[entry.component], day)
      } else {
        markRevoked(checkDecision(approved, entry.component, entry.check), day)
        markRevoked(checkDecision(notApplicable, entry.component, entry.check), day)
      }
    }
  }
  return { approved, notApplicable, excluded }
}

export const auditLine = (audit) => {
  if (!audit) return ''
  return [audit.ref, audit.reason, `${audit.by} · ${audit.at}`].filter(Boolean).join(' · ')
}

const TYPES = new Set(['deviation', 'not-applicable', 'exclusion', 'revoke'])
const TYPES_NEEDING_CHECK = new Set(['deviation', 'not-applicable'])
const CHECK_ID = /^[a-z][a-z0-9-]*$/i

// Append-only, so an oversized field can never be edited out again.
const LIMITS = { component: 200, check: 40, ref: 500, reason: 2000 }

// -> an error string, or null when the body may become an entry.
export function validateEntry(body = {}) {
  if (!TYPES.has(body.type)) return `type must be one of ${[...TYPES].join(', ')}`
  if (typeof body.component !== 'string' || !body.component.trim()) return 'component is required'
  if (TYPES_NEEDING_CHECK.has(body.type) && !body.check) return 'check is required'
  if (body.check != null && (typeof body.check !== 'string' || !CHECK_ID.test(body.check))) {
    return 'check must be a short identifier'
  }
  for (const [field, max] of Object.entries(LIMITS)) {
    if (body[field] != null && String(body[field]).length > max) {
      return `${field} must be at most ${max} characters`
    }
  }
  return null
}

// `ts` and `author` are the server's to set — a client could sign or back-date someone else's decision.
export const buildEntry = (body, author) => {
  const reason = body.reason ? String(body.reason).trim() : ''
  return {
    ts: new Date().toISOString(),
    type: body.type,
    component: body.component.trim(),
    ...(body.check ? { check: body.check } : {}),
    ...(body.ref ? { ref: String(body.ref).trim() } : {}),
    ...(reason ? { reason } : {}),
    author,
  }
}
