/* Who took a decision, and whether they were allowed to. Pure functions over the claims of an
   ALREADY verified token — signature, issuer and expiry are requireAuth's job. */

// Falling order of readability. Identity, not authorization — never gate on this.
export const authorFrom = (claims = {}) => claims.name || claims.preferred_username || claims.email || 'unknown'

/* An address counts only when the directory vouches for it: a verified `email`, or
   `preferred_username` (the UPN, which the user cannot edit). An unverified email would let anyone
   onto the list by typing a curator's address into their profile. Empty list grants nobody.
   Swapping the allowlist for a Keycloak role replaces this function and nothing else. */
export function mayCurate(claims = {}, allowlist = []) {
  const allowed = new Set(allowlist.map((a) => String(a).trim().toLowerCase()).filter(Boolean))
  if (!allowed.size) return false
  const ids = []
  if (claims.email && claims.email_verified === true) ids.push(claims.email)
  if (claims.preferred_username) ids.push(claims.preferred_username)
  return ids.some((id) => allowed.has(String(id).trim().toLowerCase()))
}
