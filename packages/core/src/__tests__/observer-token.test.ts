import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OBSERVER_TTL_MS,
  DEFAULT_OBSERVER_URL,
  buildObserverUrl,
  mintObserverToken,
  parseObserverDuration,
  resolveObserverBaseUrl,
  resolveObserverTtlMs,
} from '../observer-token.js';

const OK_BODY = {
  data: { id: 'ot_1', token: 'ot_live_abc123', expires_at: '2026-09-03T00:00:00.000Z' },
};

function okFetch(capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return { ok: true, json: async () => OK_BODY } as Response;
  }) as unknown as typeof fetch;
}

describe('resolveObserverBaseUrl', () => {
  it('prefers an explicit URL, then RELAY_OBSERVER_URL, then the hosted default', () => {
    const env = { RELAY_OBSERVER_URL: 'https://observer.relaycast.dev' } as NodeJS.ProcessEnv;
    expect(resolveObserverBaseUrl('https://staging.example/observer', env)).toBe(
      'https://staging.example/observer'
    );
    expect(resolveObserverBaseUrl(undefined, env)).toBe('https://observer.relaycast.dev');
    expect(resolveObserverBaseUrl(undefined, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_OBSERVER_URL);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'not a url'])(
    'rejects %s rather than building a link that leaks the token',
    (value) => {
      expect(() => resolveObserverBaseUrl(value, {} as NodeJS.ProcessEnv)).toThrow();
    }
  );

  it.each([
    'http://observer.example.com/observer',
    'http://192.168.1.10:4000/observer',
  ])('rejects cleartext %s — the link carries a bearer token', (value) => {
    expect(() => resolveObserverBaseUrl(value, {} as NodeJS.ProcessEnv)).toThrow(/https/);
  });

  it.each([
    'http://localhost:4000/observer',
    'http://127.0.0.1:4000/observer',
    'http://[::1]:4000/observer',
    'http://dash.localhost/observer',
  ])('allows cleartext %s — nothing crosses a network', (value) => {
    expect(resolveObserverBaseUrl(value, {} as NodeJS.ProcessEnv)).toBe(value);
  });
});

describe('buildObserverUrl', () => {
  it('appends the observer token as the key parameter', () => {
    expect(buildObserverUrl(DEFAULT_OBSERVER_URL, 'ot_live_abc123')).toBe(
      'https://agentrelay.com/observer?key=ot_live_abc123'
    );
  });

  it.each(['rk_live_secret', 'at_live_secret', 'plain'])(
    'refuses to put %s in a shareable URL',
    (token) => {
      expect(() => buildObserverUrl(DEFAULT_OBSERVER_URL, token)).toThrow(/scoped observer token/);
    }
  );
});

describe('observer token lifetime', () => {
  it.each([
    ['30m', 1_800_000],
    ['24h', 86_400_000],
    ['7d', 604_800_000],
  ])('parses %s', (value, expected) => {
    expect(parseObserverDuration(value)).toBe(expected);
  });

  it.each(['24', '0h', '-1d', '', 'soon', '91d'])('rejects %s', (value) => {
    expect(parseObserverDuration(value)).toBeNull();
  });

  it('falls back to the default rather than throwing on a typo', () => {
    expect(resolveObserverTtlMs({ RELAY_OBSERVER_EXPIRES: 'oops' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_OBSERVER_TTL_MS
    );
    expect(resolveObserverTtlMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_OBSERVER_TTL_MS);
    expect(resolveObserverTtlMs({ RELAY_OBSERVER_EXPIRES: '7d' } as NodeJS.ProcessEnv)).toBe(
      604_800_000
    );
  });
});

describe('mintObserverToken', () => {
  it('requests every read scope with the workspace key and an explicit expiry', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const minted = await mintObserverToken({
      baseUrl: 'https://api.relaycast.dev',
      workspaceKey: 'rk_live_secret',
      name: 'relayflows-wf-demo',
      filters: { include_dms: false, channel_names: ['wf-demo'] },
      now: () => 0,
      ttlMs: 1000,
      fetchImpl: okFetch(capture),
    });

    expect(minted).toEqual({
      token: 'ot_live_abc123',
      id: 'ot_1',
      expiresAt: '2026-09-03T00:00:00.000Z',
    });
    expect(capture.url).toBe('https://api.relaycast.dev/v1/observer-tokens');

    const headers = capture.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer rk_live_secret');

    const body = JSON.parse(String(capture.init?.body));
    expect(body.scopes).toContain('stream:read');
    expect(body.filters).toEqual({ include_dms: false, channel_names: ['wf-demo'] });
    expect(body.expires_at).toBe('1970-01-01T00:00:01.000Z');
  });

  it('records include_dms explicitly rather than as an absence', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await mintObserverToken({
      baseUrl: 'https://api.relaycast.dev',
      workspaceKey: 'rk_live_secret',
      name: 'relayflows-wf-demo',
      filters: { include_dms: true },
      fetchImpl: okFetch(capture),
    });

    expect(JSON.parse(String(capture.init?.body)).filters).toEqual({ include_dms: true });
  });

  it.each([
    ['a non-2xx response', { ok: false, json: async () => ({}) }],
    ['a body with no token', { ok: true, json: async () => ({ data: { id: 'ot_1' } }) }],
    [
      'a workspace key returned in the token field',
      { ok: true, json: async () => ({ data: { id: 'ot_1', token: 'rk_live_nope' } }) },
    ],
    ['a body with no id', { ok: true, json: async () => ({ data: { token: 'ot_live_abc' } }) }],
  ])('returns null on %s', async (_label, response) => {
    const minted = await mintObserverToken({
      baseUrl: 'https://api.relaycast.dev',
      workspaceKey: 'rk_live_secret',
      name: 'relayflows-wf-demo',
      fetchImpl: (async () => response as Response) as unknown as typeof fetch,
    });

    expect(minted).toBeNull();
  });

  it('returns null instead of throwing when the engine is unreachable', async () => {
    const minted = await mintObserverToken({
      baseUrl: 'https://api.relaycast.dev',
      workspaceKey: 'rk_live_secret',
      name: 'relayflows-wf-demo',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    expect(minted).toBeNull();
  });
});
