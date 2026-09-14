// Editor-facing types for the architecture model. Mirrors schema/fe-architecture.schema.json
// (the schema is the enforced contract; these give IDE hints from JSDoc in the JS sources).

export interface InventoryItem {
  name: string
  abbr?: string
  type?: string
  /** Optional refinement of type (subtype-* topic) — closed per parent type. */
  subtype?: string
  /** Derived, never curated: build-file scan > toolingVersions > GitHub primaryLanguage. */
  language?: string
  /** Derived alongside language (e.g. "Quarkus 3.20.4", "React 19.2.3"). */
  framework?: string
  status?: string
  owner?: string
  cluster?: string
  applications?: string[]
  description?: string
  contact?: string
  repo?: string | null
  repoName?: string | null
  /** Canonical service id (backlog #16); equals the inventory name. */
  serviceId?: string
  /** Owning repo folder, or null for a repo-less service. */
  serviceRepo?: string | null
  introDate?: string
  sunsetDate?: string
  comment?: string
  doc?: string
  docUrl?: string
  pushedAt?: string | null
  createdAt?: string | null
  archived?: boolean
  /** Live GitHub health: Dependabot alert counts + latest CI run. */
  health?: Record<string, unknown>
  /** Auto-scaffolded from an ACR image with no curated repo. */
  scaffold?: boolean
  azure?: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface InternalDep {
  name: string
  version?: string
  dev?: boolean
}

export interface Repo {
  folder: string
  kind: string
  displayName?: string
  /** Canonical service id (backlog #16); equals the inventory name. */
  serviceId?: string
  /** Owning repo folder (this repo, by default). */
  serviceRepo?: string | null
  inOrg?: boolean
  remote?: string | null
  language?: string
  framework?: string
  name?: string
  version?: string
  defaultBranch?: string
  lastCommit?: string | null
  externals?: Array<{ name: string; via?: string }>
  endpoints?: string[]
  endpointLinks?: Record<string, string>
  liveUrl?: string | null
  apiUrl?: string | null
  swagger?: string | null
  internalDeps?: InternalDep[]
  toolingVersions?: Record<string, string>
  moduleGraph?: { topFolders?: string[] } | null
  deployment?: Array<Record<string, unknown>>
  feToBe?: { method?: string; backends?: string[]; envVars?: string[] } | null
  inventory?: InventoryItem | null
  azure?: Record<string, unknown> | null
}

export interface Integration {
  source: string
  target: string
  protocol?: string
  channel?: string
  note?: string
  verified?: boolean
}

export interface BackendTopology {
  backends?: Array<Record<string, unknown>>
  feBe?: Record<string, unknown>
  backendExternals?: Record<string, unknown>
  assetConsumers?: unknown[]
  serviceEdges?: Array<{ source?: string; target?: string }>
  contentRepos?: Array<Record<string, unknown>>
  restHostAliases?: Record<string, string>
}

export interface ArchData {
  org?: string
  generatedAt?: string
  repos: Repo[]
  inventory: InventoryItem[]
  integrations?: Integration[]
  uiConsumers?: Array<{ repo: string; version?: string }>
  /** Framework name → services building on it (backend counterpart of uiConsumers). */
  frameworkConsumers?: Record<string, Array<{ name: string; version?: string | null; artifacts?: string[] }>>
  backendTopology?: BackendTopology
  validation?: Record<string, string[]>
  azure?: Record<string, unknown>
  extras?: Record<string, unknown> | null
}
