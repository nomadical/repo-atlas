// One night's rows, shared by the backfill (git log replay) and the nightly append —
// the two must not diverge on what a row is.
export const TYPE = { service:'Service', client:'Client', library:'Library', tests:'Tests', data:'Data',
  firmware:'Firmware', hardware:'Hardware', infra:'Infrastructure', assets:'Assets',
  'third-party-service':'Third-Party Service', config:'Config' }
export const topic = (t, p) => (t.find((x) => x.startsWith(p)) || '').slice(p.length)
export const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : ''
// An unknown-but-present type-* topic keeps its (capitalised) slug rather than lying "Unclassified".
export const typeOf = (topics) => TYPE[topic(topics, 'type-')] || cap(topic(topics, 'type-')) || 'Unclassified'
export const ver = (v) => v ? String(v).replace(/^[\^~>=<\s]+/, '') : v

// meta/fe/be: parsed github-meta.json, fe-architecture.json, backend-tooling.json for one night.
//
// runtime (optional): runtime-facts.json — what your observability platform actually received, as
// three repo lists (checked / logs / traces) plus the platform names to credit. A repo can't prove
// this about itself (it logs JSON to stdout and a cluster collector forwards it), so measured facts
// beat the repo scan for the repos in `checked`; repos outside it keep their scanned values.
// Write it from whatever your platform's API is — see docs/goldenpath/spec.md for the shape.
// The "not found" values must not contain the platform names, or conforms() reads them as passing.
export function rowsFrom({ meta, fe, be, runtime }) {
  if (!meta?.repos) return null
  fe = fe || {}
  const scanned = be?.scanned || {}
  const feRepo = Object.fromEntries((fe.repos || []).map((r) => [r.folder, r]))
  const inv = Object.fromEntries((fe.inventory || []).filter((e) => e.repoName).map((e) => [e.repoName, e]))
  // Scan output is keyed by checkout folder, which can lag a GitHub rename — re-key on the
  // remote name so a renamed repository doesn't read as "never scanned".
  const be_ = {}
  for (const [folder, s] of Object.entries(scanned)) be_[s.repoName || folder] = s

  const rows = {}
  for (const [name, m] of Object.entries(meta.repos)) {
    const topics = m.topics || []
    const i = inv[name], f = feRepo[name], b = be_[name]
    const tv = f?.toolingVersions || {}
    const owner = i?.owner || topic(topics, 'owner-').toUpperCase().split('-').join('.')
    const row = {
      repository: name,
      type: typeOf(topics),
      owner,
      applications: i?.applications || topics.filter((t) => t.startsWith('app-')).map((t) => t.slice(4)),
      status: i?.status || cap(topic(topics, 'status-')),
      language: b ? b.java : tv.typescript ? `TypeScript ${ver(tv.typescript)}` : tv.react ? 'JavaScript' : null,
      framework: b ? b.framework : tv.react ? `React ${ver(tv.react)}` : null,
      buildTool: b ? b.buildTool : null,
    }
    // null = "scanned, has none"; missing key = "could not tell" — the page counts them differently.
    if (b && 'db' in b) row.database = b.db
    if (b && 'log' in b) row.logging = b.log
    if (b && 'trace' in b) row.tracing = b.trace
    // Array.isArray on every list: a malformed file must not crash the night, and a string here
    // would substring-match via String#includes and fake plausible verdicts.
    if (Array.isArray(runtime?.checked) && runtime.checked.includes(name)) {
      const logPlatform = runtime.loggingPlatform || 'Logs received'
      const tracePlatform = runtime.tracingPlatform || 'Traces received'
      row.logging = Array.isArray(runtime.logs) && runtime.logs.includes(name) ? logPlatform : 'No logs found'
      row.tracing = Array.isArray(runtime.traces) && runtime.traces.includes(name) ? tracePlatform : 'No traces found'
    }
    if (m.archived) row.archived = true
    if (topics.includes('arch-map-ignore')) row.archMapIgnore = true
    if (i?.contact) row.contact = i.contact
    if (i && i.name !== name) row.inventoryName = i.name
    rows[name] = row
  }
  return rows
}
