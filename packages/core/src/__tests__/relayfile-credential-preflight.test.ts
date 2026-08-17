/**
 * Relayfile credential preflight.
 *
 * A Slack human-assistance gate parks the run waiting for an answer, so a bad
 * credential does not surface as a normal step failure — it surfaces as a gate
 * that never delivers its question, reported only as `Token has expired` with no
 * indication of which credential, for which workspace, resolved from where.
 */
import { describe, it, expect } from 'vitest';
import {
  RELAYFILE_CREDENTIAL_EXPIRED_MARKER,
  assertRelayfileCredentialUsable,
  describeRelayfileCredential,
  relayfileTokenExpiresAtMs,
  relayfileJwtPayloadOf,
} from '../runner.js';

/** Build an unsigned JWT with the given payload — only the payload is ever read. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const NOW = Date.UTC(2026, 7, 17, 13, 0, 0); // 2026-08-17T13:00:00Z

function runtime(token: string, overrides: Record<string, string> = {}) {
  return {
    workspaceId: 'rw_7ccfea89',
    token,
    baseUrl: 'https://file.agentrelay.com',
    source: 'local-creds',
    ...overrides,
  };
}

describe('relayfileJwtPayloadOf', () => {
  it('decodes a payload', () => {
    expect(relayfileJwtPayloadOf(jwt({ wks: 'rw_abc', exp: 123 }))?.wks).toBe('rw_abc');
  });

  it('returns undefined for junk rather than throwing', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.!!!.c']) {
      expect(relayfileJwtPayloadOf(bad)).toBeUndefined();
    }
  });
});

describe('relayfileTokenExpiresAtMs', () => {
  it('converts exp seconds to ms', () => {
    expect(relayfileTokenExpiresAtMs(jwt({ exp: 1786000000 }))).toBe(1786000000 * 1000);
  });

  it('is undefined when exp is absent or not a finite number', () => {
    expect(relayfileTokenExpiresAtMs(jwt({}))).toBeUndefined();
    expect(relayfileTokenExpiresAtMs(jwt({ exp: 'soon' }))).toBeUndefined();
    expect(relayfileTokenExpiresAtMs(jwt({ exp: Infinity }))).toBeUndefined();
  });
});

describe('assertRelayfileCredentialUsable', () => {
  it('rejects an expired credential and names the workspace, source and expiry', () => {
    // Modelled on the credential actually found on this machine: minted
    // 06:16:16Z, expired 07:16:15Z, scoped only to /discovery/slack/** while the
    // gate writes to /slack/channels/**.
    const token = jwt({
      wks: 'rw_7ccfea89',
      exp: Math.floor(Date.UTC(2026, 7, 17, 7, 16, 15) / 1000),
      scopes: [
        'fs:read',
        'fs:write',
        'workspace:pear-integrations-discovery-slack:write:/discovery/slack/**',
      ],
    });

    let message = '';
    try {
      assertRelayfileCredentialUsable(runtime(token), 'Slack human assistance', NOW);
      throw new Error('expected assertRelayfileCredentialUsable to throw');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('Slack human assistance');
    expect(message).toContain('2026-08-17T07:16:15.000Z');
    expect(message).toContain('rw_7ccfea89');
    expect(message).toContain('source=local-creds');
    // The scopes are the other half of the diagnosis.
    expect(message).toContain('/discovery/slack/**');
    // And it says what to do about it.
    expect(message).toMatch(/relayfile login|RELAYFILE_TOKEN/);
    // Critically: the message must stay recognizable as an expired-auth error so
    // the runner's existing refresh-and-retry path still fires. Failing closed
    // must not mean skipping the recovery that would have worked.
    expect(message).toContain(RELAYFILE_CREDENTIAL_EXPIRED_MARKER);
    expect(message).toMatch(
      new RegExp(`token has expired|jwt expired|unauthorized|401|${RELAYFILE_CREDENTIAL_EXPIRED_MARKER}`, 'i')
    );
  });

  it('is silent for a credential that is still valid', () => {
    const token = jwt({ exp: Math.floor(NOW / 1000) + 3600 });
    expect(() =>
      assertRelayfileCredentialUsable(runtime(token), 'Slack human assistance', NOW)
    ).not.toThrow();
  });

  it('does not block a credential that carries no exp claim', () => {
    // Absence of `exp` is not evidence of expiry; refusing here would break
    // long-lived self-hosted tokens.
    expect(() =>
      assertRelayfileCredentialUsable(runtime(jwt({ wks: 'rw_x' })), 'Slack human assistance', NOW)
    ).not.toThrow();
  });

  it('treats exactly-at-expiry as expired', () => {
    const token = jwt({ exp: Math.floor(NOW / 1000) });
    expect(() =>
      assertRelayfileCredentialUsable(runtime(token), 'Slack human assistance', NOW)
    ).toThrow(/expired/);
  });

  it('does not throw on an unparseable token — that is a different failure', () => {
    expect(() =>
      assertRelayfileCredentialUsable(runtime('garbage'), 'Slack human assistance', NOW)
    ).not.toThrow();
  });
});

describe('describeRelayfileCredential', () => {
  it('reports relative expiry in the past tense when expired', () => {
    const token = jwt({ exp: Math.floor(NOW / 1000) - 90 * 60 });
    expect(describeRelayfileCredential(runtime(token), NOW)).toContain('expired 90m ago');
  });

  it('reports relative expiry in the future tense when live', () => {
    const token = jwt({ exp: Math.floor(NOW / 1000) + 45 * 60 });
    expect(describeRelayfileCredential(runtime(token), NOW)).toContain('expires in 45m');
  });

  it('says exp=none rather than guessing when there is no exp', () => {
    expect(describeRelayfileCredential(runtime(jwt({})), NOW)).toContain('exp=none');
  });

  it('reports source=unknown when the runtime did not record one', () => {
    const r = { workspaceId: 'rw_a', token: jwt({}), baseUrl: 'https://x' };
    expect(describeRelayfileCredential(r, NOW)).toContain('source=unknown');
  });

  it('omits the scopes field entirely when the token carries none', () => {
    expect(describeRelayfileCredential(runtime(jwt({})), NOW)).not.toContain('scopes=');
  });
});
