function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

const allowHardcoded = bool("ZOOZA_ALLOW_HARDCODED_AUTH", false);

/**
 * System-wide virtual trainer ids hardcoded in the Zooza app (`app/main.js`,
 * translation keys `enums__trainers__*`). They have no `users` row, no role,
 * and `/v1/users` never returns them — but api-v1 accepts them as valid
 * `trainer_id` values when creating / editing schedules and events. We surface
 * them via `find_trainers` so the operator can pick them by name.
 */
const BUILT_IN_VIRTUAL_TRAINERS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 9000000000001, name: "To be decided" },
  { id: 9000000000002, name: "Trainer unassigned" },
  { id: 9000000000003, name: "Guest trainer" },
];

/**
 * Parse `ZOOZA_VIRTUAL_TRAINERS=id1:Name 1,id2:Name 2,...` for any additional
 * virtual trainer ids beyond the system-wide built-ins. Comma-separated entries,
 * each `id:name`. Names may contain spaces; cannot contain commas or colons.
 * Most installations should leave this unset.
 */
function parseVirtualTrainers(raw: string): Array<{ id: number; name: string }> {
  if (!raw || raw.trim() === "") return [];
  const out: Array<{ id: number; name: string }> = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const id = Number.parseInt(trimmed.slice(0, colonIdx).trim(), 10);
    const name = trimmed.slice(colonIdx + 1).trim();
    if (!Number.isFinite(id) || id <= 0 || name.length === 0) continue;
    out.push({ id, name });
  }
  return out;
}

export const config = {
  port: Number.parseInt(optional("PORT", "3001"), 10),
  zooza: {
    baseUrl: optional("ZOOZA_API_BASE", "http://php-server/v1").replace(/\/$/, ""),
    apiKey: required("ZOOZA_API_KEY"),
    // Legacy creds — only used when allowHardcoded is true AND no Bearer arrives.
    // Required even when allowHardcoded is false because tests / dev / migration
    // windows may flip the flag without redeploy.
    legacyToken: allowHardcoded ? required("ZOOZA_API_TOKEN") : optional("ZOOZA_API_TOKEN", ""),
    legacyCompany: allowHardcoded ? required("ZOOZA_API_COMPANY") : optional("ZOOZA_API_COMPANY", ""),
  },
  auth: {
    allowHardcoded,
    // OAuth resource + auth server URLs. Required when allowHardcoded is false
    // (we can't honour the MCP authorization spec's discovery without them).
    resourceUrl: allowHardcoded
      ? optional("MCP_RESOURCE_URL", "http://localhost:3001/mcp")
      : required("MCP_RESOURCE_URL"),
    authServerUrl: allowHardcoded
      ? optional("MCP_AUTH_SERVER_URL", "")
      : required("MCP_AUTH_SERVER_URL"),
    // JWKS at {authServerUrl}/.well-known/jwks.json by convention.
    jwksCacheTtlSeconds: Number.parseInt(
      optional("MCP_JWKS_CACHE_TTL_SECONDS", "3600"),
      10,
    ),
    // `aud` enforcement off by default — zooza-auth doesn't issue the claim yet
    // (see handoff zooza-mcp-to-api-v1-20260523-002 + auth-team follow-up).
    requireAud: bool("MCP_REQUIRE_AUD", false),
  },
  trainers: {
    virtual: [
      ...BUILT_IN_VIRTUAL_TRAINERS,
      ...parseVirtualTrainers(optional("ZOOZA_VIRTUAL_TRAINERS", "")),
    ],
  },
  /**
   * Which Zooza regional installation this MCP instance serves.
   * EU (SK/CZ/DE/RO/HU/IT/PL) is the default.
   * Set ZOOZA_SERVER_REGION=uk for the UK deployment, etc.
   */
  serverRegion: optional("ZOOZA_SERVER_REGION", "eu"),
} as const;
