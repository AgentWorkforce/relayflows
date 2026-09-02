/**
 * Read-only observer links for workflow runs.
 *
 * A workspace key (`rk_live_`) is an administrative credential: it can send
 * messages, spawn and remove agents, and change workspace settings. It has no
 * business in a URL — query strings land in browser history, referrer headers,
 * and proxy logs — and the engine rejects it on the realtime endpoint outright,
 * so a link built from one cannot stream in the first place.
 *
 * The supported credential for "let a human watch this run" is a scoped
 * observer token (`ot_live_`): read-only, individually revocable, expiring, and
 * narrowable to specific channels. This module mints one per run and builds the
 * observer URL from it, so the runner can print a link that is safe to paste.
 *
 * Mirrors `agent-relay observer` (relay `packages/cli/src/cli/commands/observer.ts`)
 * so both produce identical links.
 */

/** Where the hosted observer dashboard lives. */
export const DEFAULT_OBSERVER_URL = 'https://agentrelay.com/observer';

/** Default token lifetime. Long enough to outlive a run, short enough to expire. */
export const DEFAULT_OBSERVER_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on how long a run's observer link may be kept alive. */
const MAX_OBSERVER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Minting must never delay a run start; give up rather than hang on the engine. */
const MINT_TIMEOUT_MS = 10_000;

/**
 * Every read scope, mirroring the engine's `OBSERVER_SCOPES`. `stream:read` is
 * what makes the token usable on the realtime endpoint (`GET /v1/ws`) — without
 * it the token can read REST but never streams, which is the whole point here.
 */
export const OBSERVER_SCOPES = [
  'stream:read',
  'messages:read',
  'threads:read',
  'dms:read',
  'channels:read',
  'search:read',
  'agents:read',
  'nodes:read',
  'deliveries:read',
  'activity:read',
  'files:read',
  'reactions:read',
] as const;

/** Visibility filters narrowing what the minted token can see (engine wire format). */
export interface ObserverTokenFilters {
  /** Restrict to these channel names. Omit for every channel in the workspace. */
  channel_names?: string[];
  /** Include agent DM traffic. Off unless explicitly requested. */
  include_dms?: boolean;
}

export interface MintObserverTokenOptions {
  /** Relaycast engine base URL. */
  baseUrl: string;
  /** Workspace key (`rk_live_...`) — only a workspace key may mint observer tokens. */
  workspaceKey: string;
  /** Token name. Must be unique within the workspace. */
  name: string;
  description?: string;
  filters?: ObserverTokenFilters;
  /** Token lifetime. Defaults to {@link DEFAULT_OBSERVER_TTL_MS}. */
  ttlMs?: number;
  /** Injected in tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface MintedObserverToken {
  /** Raw `ot_live_` material. Returned once, at creation, and never again. */
  token: string;
  /** Observer-token id, for `agent-relay observer revoke <id>`. */
  id: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

/**
 * Resolve the observer dashboard base URL: explicit value, then
 * `RELAY_OBSERVER_URL` (for self-hosted or staging dashboards), then the hosted
 * default.
 *
 * @throws if the resolved value is not an http(s) URL — the token is appended to
 * this URL's query string, so the scheme decides where a live credential ends
 * up, and `new URL` happily accepts `data:` and `javascript:`.
 */
export function resolveObserverBaseUrl(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = explicit?.trim() || env.RELAY_OBSERVER_URL?.trim() || DEFAULT_OBSERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid observer URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Observer URL must be http or https: ${value}`);
  }
  return value;
}

/**
 * Build the observer URL for a minted token.
 *
 * @throws if handed anything but an `ot_live_` token — a workspace key in this
 * position would put an administrative credential in a shareable URL, the exact
 * failure this module exists to prevent.
 */
export function buildObserverUrl(baseUrl: string, token: string): string {
  if (!token.startsWith('ot_live_')) {
    throw new Error('Observer URLs require a scoped observer token (ot_live_...).');
  }
  const url = new URL(baseUrl);
  url.searchParams.set('key', token);
  return url.toString();
}

/**
 * Parse a `30m` / `24h` / `7d` duration into milliseconds. Bare digits are
 * rejected rather than guessed at — `24` is far more likely to mean hours than
 * milliseconds, and silently picking either would be wrong.
 *
 * @returns the duration in ms, or `null` if the value is unparseable or out of range
 */
export function parseObserverDuration(value: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (amount <= 0) return null;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  const total = amount * unitMs;
  // A token outliving the workspace is a liability rather than a convenience.
  return total > MAX_OBSERVER_TTL_MS ? null : total;
}

/**
 * Resolve the observer token lifetime from `RELAY_OBSERVER_EXPIRES`, falling
 * back to the default. An unparseable value falls back rather than throwing:
 * a typo in an env var should not cost the user their observer link.
 */
export function resolveObserverTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.RELAY_OBSERVER_EXPIRES?.trim();
  if (!configured) return DEFAULT_OBSERVER_TTL_MS;
  return parseObserverDuration(configured) ?? DEFAULT_OBSERVER_TTL_MS;
}

/**
 * Mint a scoped, read-only observer token.
 *
 * Fails soft: any rejection (network, non-2xx, malformed body, timeout) returns
 * `null` so the caller can carry on without a link. A run must never fail
 * because an observability convenience could not be created.
 *
 * @returns the minted token, or `null` if it could not be minted
 */
export async function mintObserverToken(
  options: MintObserverTokenOptions
): Promise<MintedObserverToken | null> {
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? fetch;
  const expiresAt = new Date(now() + (options.ttlMs ?? DEFAULT_OBSERVER_TTL_MS)).toISOString();

  try {
    const res = await doFetch(new URL('/v1/observer-tokens', options.baseUrl).toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: options.name,
        ...(options.description === undefined ? {} : { description: options.description }),
        scopes: [...OBSERVER_SCOPES],
        // `include_dms` defaults to false server-side, but send it explicitly so
        // the token's stored filters record the decision rather than an absence.
        filters: {
          include_dms: options.filters?.include_dms === true,
          ...(options.filters?.channel_names?.length
            ? { channel_names: options.filters.channel_names }
            : {}),
        },
        expires_at: expiresAt,
      }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as Record<string, any>;
    const data = (body?.data ?? body) as Record<string, any>;
    const token = data?.token;
    const id = data?.id;
    if (typeof token !== 'string' || !token.startsWith('ot_live_')) return null;
    if (typeof id !== 'string' || id.length === 0) return null;

    return { token, id, expiresAt: data?.expires_at ?? expiresAt };
  } catch {
    return null;
  }
}
