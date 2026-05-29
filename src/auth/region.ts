import { config } from "../config.js";

/**
 * Resolve the api-v1 base URL for the JWT `region` claim (e.g. `region: "eu"`).
 * Returns `null` when the region is absent, malformed, or has no configured
 * `ZOOZA_API_BASE_<REGION>` env var.
 *
 * There is no global fallback base URL: callers MUST reject when this returns
 * null rather than route to a default installation. The region is upper-cased
 * before validation/lookup — JWT claims arrive lower-case (`"eu"`) while env
 * keys are upper-case (`ZOOZA_API_BASE_EU`).
 */
export function resolveBaseUrl(region: string | null | undefined): string | null {
  if (!region) return null;
  const code = region.toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(code)) return null;
  return config.zooza.regionBaseUrls[code] ?? null;
}
