import { describe, expect, it } from 'vitest';

import {
  agentCredentialEnv,
  applySubscriptionPrecedence,
  brokerCredentialEnv,
  shadowedCredentialKeys,
  SUBSCRIPTION_LOGINS_ENV,
} from '../credential-precedence.js';

const BOTH = {
  ANTHROPIC_API_KEY: 'sk-ant-api',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
  OPENAI_API_KEY: 'sk-openai',
  XAI_API_KEY: 'xai-key',
  PATH: '/bin',
};

describe('credential precedence', () => {
  it('a Claude setup token shadows the Anthropic API key for Claude only', () => {
    expect(shadowedCredentialKeys(BOTH, 'claude')).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(applySubscriptionPrecedence(BOTH, 'claude')).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
      OPENAI_API_KEY: 'sk-openai',
      XAI_API_KEY: 'xai-key',
      PATH: '/bin',
    });
    expect(applySubscriptionPrecedence(BOTH, 'opencode')).toEqual(BOTH);
    expect(applySubscriptionPrecedence(BOTH, '/usr/local/bin/claude').ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('no subscription, no change', () => {
    const keysOnly = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' };
    expect(shadowedCredentialKeys(keysOnly)).toEqual([]);
    expect(applySubscriptionPrecedence(keysOnly, 'claude')).toEqual(keysOnly);
    expect(applySubscriptionPrecedence({ ...keysOnly, CLAUDE_CODE_OAUTH_TOKEN: ' ' }, 'claude')).toHaveProperty(
      'ANTHROPIC_API_KEY'
    );
  });

  it('materialised Codex and Grok logins shadow OpenAI and xAI keys for their CLIs', () => {
    const env = { ...BOTH, CLAUDE_CODE_OAUTH_TOKEN: undefined, [SUBSCRIPTION_LOGINS_ENV]: 'codex, grok' };
    expect(shadowedCredentialKeys(env, 'codex')).toEqual(['OPENAI_API_KEY']);
    expect(shadowedCredentialKeys(env, 'grok')).toEqual(['XAI_API_KEY']);
    expect(shadowedCredentialKeys(env, 'claude')).toEqual([]);
    expect(applySubscriptionPrecedence(env, 'codex').OPENAI_API_KEY).toBeUndefined();
    expect(applySubscriptionPrecedence(env, 'claude').OPENAI_API_KEY).toBe('sk-openai');
  });

  it('the broker drops every shadowed key and each agent gets back only what its CLI may use', () => {
    const env = { ...BOTH, [SUBSCRIPTION_LOGINS_ENV]: 'codex' };
    const broker = brokerCredentialEnv(env);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
      expect(Object.hasOwn(broker, key)).toBe(true);
      expect(broker[key as keyof typeof broker]).toBeUndefined();
    }
    expect(broker.XAI_API_KEY).toBe('xai-key');
    expect(agentCredentialEnv(env, 'claude')).toEqual({ OPENAI_API_KEY: 'sk-openai' });
    expect(agentCredentialEnv(env, 'codex')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api', ANTHROPIC_AUTH_TOKEN: 'tok' });
    expect(agentCredentialEnv(env, 'opencode')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-api',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      OPENAI_API_KEY: 'sk-openai',
    });
  });
});
