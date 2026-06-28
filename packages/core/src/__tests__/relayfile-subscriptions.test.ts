import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cloud from '@agent-relay/cloud';

vi.mock('@agent-relay/cloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/cloud')>();
  return {
    ...actual,
    authorizedApiFetch: vi.fn(),
    readStoredAuth: vi.fn(),
  };
});

import { WorkflowRunner } from '../runner.js';
import type { RelayYamlConfig } from '../types.js';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

describe('Relayfile integration subscriptions', () => {
  afterEach(() => {
    vi.mocked(cloud.authorizedApiFetch).mockReset();
    vi.mocked(cloud.readStoredAuth).mockReset();
    vi.useRealTimers();
  });

  it('collects workflow and agent subscriptions with normalized events', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const config: RelayYamlConfig = {
      version: '1.0',
      name: 'subscription-test',
      swarm: { pattern: 'dag' },
      integrations: {
        relayfile: {},
        subscriptions: [
          {
            name: 'global-pr-feedback',
            provider: 'github',
            path: '/github/repos/acme/web/pulls/42/**',
            events: ['created', 'updated'],
            agents: ['pr-babysitter'],
          },
        ],
      },
      agents: [
        {
          name: 'pr-babysitter',
          cli: 'codex',
          watch: [
            {
              paths: ['/github/repos/acme/web/pulls/42/reviews/**'],
              events: ['created'],
            },
          ],
          subscriptions: [
            {
              name: 'slack-updates',
              provider: 'slack',
              paths: ['/slack/channels/C123/**'],
              event: 'file.created',
            },
          ],
        },
      ],
      workflows: [],
    };

    const subscriptions = (runner as any).collectRelayfileSubscriptions(config);

    expect(subscriptions).toEqual([
      expect.objectContaining({
        name: 'global-pr-feedback',
        provider: 'github',
        paths: ['/github/repos/acme/web/pulls/42/**'],
        events: ['file.created', 'file.updated'],
        targetAgents: ['pr-babysitter'],
        source: 'workflow',
      }),
      expect.objectContaining({
        name: 'pr-babysitter.watch.1',
        paths: ['/github/repos/acme/web/pulls/42/reviews/**'],
        events: ['file.created'],
        targetAgents: ['pr-babysitter'],
        source: 'agent',
        ownerAgent: 'pr-babysitter',
      }),
      expect.objectContaining({
        name: 'slack-updates',
        provider: 'slack',
        paths: ['/slack/channels/C123/**'],
        events: ['file.created'],
        targetAgents: ['pr-babysitter'],
        source: 'agent',
        ownerAgent: 'pr-babysitter',
      }),
    ]);
  });

  it('matches Relayfile event paths against subscription globs', () => {
    expect((WorkflowRunner as any).pathGlobMatches('/github/repos/acme/web/pulls/42/**', '/github/repos/acme/web/pulls/42/reviews/1.json')).toBe(true);
    expect((WorkflowRunner as any).pathGlobMatches('/github/repos/acme/web/pulls/*/reviews/**', '/github/repos/acme/web/pulls/42/reviews/1.json')).toBe(true);
    expect((WorkflowRunner as any).pathGlobMatches('/github/repos/acme/web/pulls/*/reviews/**', '/github/repos/acme/web/issues/42.json')).toBe(false);
  });

  it('executes waitFor gates from Relayfile stream events', async () => {
    const callbacks: Array<{ globs: string[]; onChange: (event: any) => void; options?: any }> = [];
    const client = {
      open: () => ({
        ready: Promise.resolve(),
        unsubscribe: async () => undefined,
      }),
      subscribe: (globs: string[], onChange: (event: any) => void, options?: any) => {
        callbacks.push({ globs, onChange, options });
        return { unsubscribe: async () => undefined };
      },
    };
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    (runner as any).relayfileRuntimeConfig = {
      baseUrl: 'https://file.agentrelay.com',
      workspaceId: 'ws-test',
      token: [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify({ workspace_id: 'ws-test', agent_name: 'runner' })).toString('base64url'),
        '',
      ].join('.'),
    };
    (runner as any).relayfileClient = client;

    const config: RelayYamlConfig = {
      version: '1.0',
      name: 'waitfor-test',
      swarm: { pattern: 'dag' },
      integrations: {
        relayfile: { mount: false },
      },
      agents: [],
      workflows: [
        {
          name: 'default',
          steps: [
            {
              name: 'wait-review',
              type: 'waitFor',
              waitFor: {
                provider: 'github',
                path: '/github/repos/acme/web/pulls/42/reviews/**',
                event: 'created',
                timeoutMs: 1000,
              },
            },
          ],
        },
      ],
    };

    const run = runner.execute(config, 'default');
    await waitUntil(() => callbacks.length === 1);
    expect(callbacks[0]?.globs).toEqual(['/github/repos/acme/web/pulls/42/reviews/**']);
    callbacks[0]?.onChange({
      id: 'evt-1',
      workspace: 'ws-test',
      type: 'relayfile.changed',
      occurredAt: new Date().toISOString(),
      resource: {
        path: '/github/repos/acme/web/pulls/42/reviews/rev-1.json',
        kind: 'github.pull_request_review',
        id: 'rev-1',
        provider: 'github',
      },
      summary: { status: 'changes_requested' },
      expand: async () => ({ level: 'summary', path: '/github/repos/acme/web/pulls/42/reviews/rev-1.json', summary: {} }),
    });

    await expect(run).resolves.toMatchObject({
      workflowName: 'default',
      status: 'completed',
    });
  });

  it('does not leak waiters when waitFor subscription setup throws synchronously', async () => {
    const client = {
      open: () => ({
        ready: Promise.resolve(),
        unsubscribe: async () => undefined,
      }),
      subscribe: () => {
        throw new Error('subscribe failed');
      },
    };
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    (runner as any).relayfileRuntimeConfig = {
      baseUrl: 'https://file.agentrelay.com',
      workspaceId: 'ws-test',
      token: [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify({ workspace_id: 'ws-test', agent_name: 'runner' })).toString('base64url'),
        '',
      ].join('.'),
    };
    (runner as any).relayfileClient = client;

    await expect(
      (runner as any).waitForRelayfileEvent({
        name: 'wait-review',
        paths: ['/github/repos/acme/web/pulls/42/reviews/**'],
        events: ['file.created'],
        provider: 'github',
        source: 'workflow',
      }, 1000)
    ).rejects.toThrow('subscribe failed');
    expect((runner as any).relayfileEventWaiters).toHaveLength(0);
  });

  it('resolves Relayfile runtime from local Pear credentials without workflow secrets', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'relayflows-relayfile-'));
    try {
      const credsDir = path.join(tmp, 'discovery', 'slack', '.relay');
      await mkdir(credsDir, { recursive: true });
      const token = [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify({ wks: 'rw_local_test' })).toString('base64url'),
        '',
      ].join('.');
      await writeFile(path.join(credsDir, 'creds.json'), JSON.stringify({ token }), 'utf8');

      const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
      const config: RelayYamlConfig = {
        version: '1.0',
        name: 'local-creds-test',
        swarm: { pattern: 'dag' },
        integrations: {
          relayfile: {
            localRoot: tmp,
            mount: false,
          },
        },
        agents: [],
        workflows: [],
      };

      const runtime = await (runner as any).resolveRelayfileRuntimeConfigForUse(config, { ensureMount: false });

      expect(runtime).toMatchObject({
        workspaceId: 'rw_local_test',
        token,
        baseUrl: 'https://file.agentrelay.com',
        source: 'local-creds',
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('resolves Slack channel names to ids from the local Relayfile channel index', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'relayflows-slack-index-'));
    try {
      const channelsDir = path.join(tmp, 'slack', 'channels');
      await mkdir(channelsDir, { recursive: true });
      await writeFile(
        path.join(channelsDir, '_index.json'),
        JSON.stringify([
          {
            id: 'C123ABCDEF',
            name: 'proj-cloud',
            title: 'proj-cloud',
            messagesPath: '/slack/channels/C123ABCDEF/messages',
          },
        ]),
        'utf8'
      );

      const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });

      await expect((runner as any).resolveLocalSlackChannelId(tmp, '#proj-cloud')).resolves.toBe('C123ABCDEF');
      await expect((runner as any).resolveLocalSlackChannelId(tmp, 'PROJ-CLOUD')).resolves.toBe('C123ABCDEF');
      await expect((runner as any).resolveLocalSlackChannelId(tmp, 'C123ABCDEF')).resolves.toBe('C123ABCDEF');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('resolves Slack channel names from local by-name aliases', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'relayflows-slack-by-name-'));
    try {
      const byNameDir = path.join(tmp, 'slack', 'channels', 'by-name');
      await mkdir(byNameDir, { recursive: true });
      await writeFile(
        path.join(byNameDir, 'watchdog-test.json'),
        JSON.stringify({
          id: 'C0WATCHDOG',
          name: 'watchdog-test',
          path: '/slack/channels/C0WATCHDOG__watchdog-test/meta.json',
        }),
        'utf8'
      );

      const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });

      await expect((runner as any).resolveLocalSlackChannelId(tmp, '#watchdog-test')).resolves.toBe('C0WATCHDOG');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('resolves Slack channel names from cloud integration options when Relayfile metadata is stale', async () => {
    const auth = {
      apiUrl: 'https://agentrelay.test/cloud',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.mocked(cloud.readStoredAuth).mockResolvedValue(auth);
    vi.mocked(cloud.authorizedApiFetch).mockImplementation(async (activeAuth, requestPath) => {
      if (requestPath === '/api/v1/auth/whoami') {
        return {
          auth: activeAuth,
          response: new Response(
            JSON.stringify({
              authenticated: true,
              currentWorkspace: { id: 'account-workspace-id' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
        };
      }
      if (requestPath === '/api/v1/workspaces/account-workspace-id/integrations/slack/options/channels') {
        return {
          auth: activeAuth,
          response: new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
        };
      }
      if (requestPath === '/api/v1/workspaces/account-workspace-id/integrations/slack/channels/available') {
        return {
          auth: activeAuth,
          response: new Response(
            JSON.stringify({
              channels: [{ id: 'C0WATCHDOG', name: 'watchdog-test' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
        };
      }
      throw new Error(`unexpected request path: ${requestPath}`);
    });

    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    vi.spyOn(runner as any, 'resolveRelayfileLocalRoot').mockResolvedValue(undefined);
    const client = {
      readFile: vi.fn().mockRejectedValue(new Error('not found')),
    };

    await expect(
      (runner as any).resolveRelayfileSlackChannelId({
        channel: 'watchdog-test',
        client,
        runtime: { workspaceId: 'relayfile-workspace-id', token: 'token', baseUrl: 'https://file.agentrelay.test' },
      })
    ).resolves.toBe('C0WATCHDOG');

    expect(vi.mocked(cloud.authorizedApiFetch).mock.calls.map(([, requestPath]) => requestPath)).toContain(
      '/api/v1/workspaces/account-workspace-id/integrations/slack/channels/available'
    );
  });

  it('propagates ambiguous local Slack channel aliases instead of falling through to cloud lookup', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'relayflows-slack-ambiguous-'));
    try {
      const byNameDir = path.join(tmp, 'slack', 'channels', 'by-name');
      await mkdir(byNameDir, { recursive: true });
      await writeFile(
        path.join(byNameDir, 'watchdog-test-a.json'),
        JSON.stringify({ id: 'C0WATCHDOGA', name: 'watchdog-test' }),
        'utf8'
      );
      await writeFile(
        path.join(byNameDir, 'watchdog-test-b.json'),
        JSON.stringify({ id: 'C0WATCHDOGB', name: 'watchdog-test' }),
        'utf8'
      );

      const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
      vi.spyOn(runner as any, 'resolveRelayfileLocalRoot').mockResolvedValue(tmp);
      vi.spyOn(runner as any, 'resolveSlackChannelIdFromCloudOptions').mockResolvedValue('C0CLOUD');
      const client = {
        readFile: vi.fn().mockRejectedValue(new Error('not found')),
      };

      await expect(
        (runner as any).resolveRelayfileSlackChannelId({
          channel: 'watchdog-test',
          client,
          runtime: { workspaceId: 'relayfile-workspace-id', token: 'token', baseUrl: 'https://file.agentrelay.test' },
        })
      ).rejects.toThrow(/ambiguous/i);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('prefers readable human-question candidates over malformed PTY renders', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const output = [
      'HUMAN_QUESTION: WhatapprovalcodeshouldIusefortheRelayflowsTypeScript',
      'HUMAN_QUESTION: What approval code should I use for the Relayflows TypeScript Slack assistance check?',
    ].join('\n');

    const candidates = (runner as any).extractHumanQuestionCandidates(output);

    expect((runner as any).selectBestHumanQuestion(candidates)).toBe(
      'What approval code should I use for the Relayflows TypeScript Slack assistance check?'
    );
  });

  it('uses the declared exact human question instead of compacted PTY output', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const declared =
      'What approval code should I use for the Relayflows TypeScript Slack assistance check?';
    const task = [
      'Ask the operator by printing exactly one line with the literal prefix HUMAN_QUESTION:',
      'followed by this exact question:',
      declared,
      '',
      'After the runner provides the reply, print ANSWER_RECEIVED.',
    ].join('\n');
    const rendered = 'WhatapprovalcodeshouldIusefortheRelayflowsTypeScript';

    expect((runner as any).extractDeclaredHumanQuestionFromTask(task)).toBe(declared);
    expect((runner as any).shouldPreferDeclaredHumanQuestion(declared, rendered)).toBe(true);
  });

  it('suppresses repeated human questions after an answer was injected', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const question = 'What approval code should I use for the Relayflows TypeScript Slack assistance check?';

    (runner as any).rememberAnsweredHumanQuestion('ask-human:owner', question);

    expect(
      (runner as any).hasAnsweredSimilarHumanQuestion(
        'ask-human:owner',
        'WhatapprovalcodeshouldIusefortheRelayflowsTypeScript'
      )
    ).toBe(true);
  });

  it('treats debounced Slack question drafts as pending human assistance', async () => {
    vi.useFakeTimers();
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const timer = setTimeout(() => undefined, 10_000);
    (runner as any).pendingHumanQuestionDrafts.set('owner', {
      agentName: 'owner',
      step: { name: 'ask-human', task: 'ask' },
      config: { slack: { channel: 'watchdog-test' } },
      question: 'Approve?',
      timer,
    });

    const pending = (runner as any).waitForPendingHumanQuestion('owner');
    await vi.advanceTimersByTimeAsync(1500);

    await expect(pending).resolves.toBe(true);
    clearTimeout(timer);
    vi.useRealTimers();
  });

  it('matches Slack answers under canonical thread reply paths', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const path =
      '/slack/channels/C0B9Z4CLG1J__watchdog-test/threads/1782623489_965309/replies/1782623749_441929/meta.json';
    const payload = {
      text: 'Approved',
      thread_ts: '1782623489.965309',
      ts: '1782623749.441929',
    };

    expect((runner as any).slackAnswerMatchesQuestionThread(payload, path, '1782623489.965309')).toBe(true);
    expect((runner as any).slackAnswerMatchesQuestionThread(payload, path, '1782623000.000000')).toBe(false);
  });

  it('uses Relayfile-supported exact-prefix Slack answer subscription paths', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });

    expect((runner as any).slackHumanAnswerSubscriptionPaths('/slack/channels/C0B9Z4CLG1J', 'watchdog-test')).toEqual([
      '/slack/channels/C0B9Z4CLG1J/**',
      '/slack/channels/C0B9Z4CLG1J__watchdog-test/**',
    ]);
  });

  it('derives Relayfile token refresh scopes from the current token without broadening scoped grants', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const token = makeJwt({
      scopes: [
        'ops:read',
        'workspace:relayflows-probe:read:/slack/channels/**',
        'workspace:relayflows-probe:write:/slack/channels/C0WATCHDOG/**',
      ],
    });

    expect((runner as any).relayfileRefreshScopes({ workspaceId: 'w', token, baseUrl: 'https://file.test' })).toEqual([
      'workspace:relayflows-probe:read:/slack/channels/**',
      'workspace:relayflows-probe:write:/slack/channels/C0WATCHDOG/**',
    ]);
  });

  it('preserves full Relayfile fs grants when the current token is already workspace-wide', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const token = makeJwt({ scopes: ['fs:read', 'fs:write', 'ops:read'] });

    expect((runner as any).relayfileRefreshScopes({ workspaceId: 'w', token, baseUrl: 'https://file.test' })).toEqual([
      'relayfile:fs:read:/**',
      'relayfile:fs:write:/**',
    ]);
  });

  it('preserves path-scoped Relayfile fs grants during token refresh', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/relayflows-test' });
    const token = makeJwt({
      scopes: ['relayfile:fs:read:/slack/channels/**', 'relayfile:fs:write:/slack/channels/C0WATCHDOG/**'],
    });

    expect((runner as any).relayfileRefreshScopes({ workspaceId: 'w', token, baseUrl: 'https://file.test' })).toEqual([
      'relayfile:fs:read:/slack/channels/**',
      'relayfile:fs:write:/slack/channels/C0WATCHDOG/**',
    ]);
  });
});
