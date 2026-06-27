import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WorkflowRunner } from '../runner.js';
import type { RelayYamlConfig } from '../types.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

describe('Relayfile integration subscriptions', () => {
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
});
