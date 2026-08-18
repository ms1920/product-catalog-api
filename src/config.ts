/**
 * Configuration, read from the environment once at startup and passed explicitly.
 *
 * Nothing deeper in the codebase reads `process.env`, which keeps modules testable
 * and makes the complete set of knobs discoverable in one file.
 */
export interface Config {
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  defaultPageSize: number;
  /** Hard ceiling. Larger requests are clamped, not rejected. */
  maxPageSize: number;
  /** `max-age` on product reads. 0 disables client caching. */
  cacheMaxAgeSeconds: number;
  /** Requests per minute per IP. */
  rateLimit: number;
  /** When set, writes require `x-api-key`. Unset = open, for local exploration. */
  apiKey: string | undefined;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    port: intFromEnv('PORT', 3000),
    nodeEnv: (process.env.NODE_ENV ?? 'development') as Config['nodeEnv'],
    defaultPageSize: intFromEnv('DEFAULT_PAGE_SIZE', 20),
    maxPageSize: intFromEnv('MAX_PAGE_SIZE', 100),
    // 60s of shared caching. Safe because writes bump the version, which changes
    // the ETag — so a stale response is detectable on the next conditional GET.
    cacheMaxAgeSeconds: intFromEnv('CACHE_MAX_AGE', 60),
    rateLimit: intFromEnv('RATE_LIMIT', 600),
    apiKey: process.env.API_KEY,
  };
}
