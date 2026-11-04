/**
 * Subscription logins win over API keys for the CLI they belong to.
 *
 * A run can receive both a subscription login and an API key for the same
 * provider: for example a Claude setup token (`CLAUDE_CODE_OAUTH_TOKEN`) for the
 * coding agent and `ANTHROPIC_API_KEY` for programmatic LLM calls. The Claude
 * CLI prefers `ANTHROPIC_API_KEY` when both are set, so the run would bill the
 * API instead of using the subscription the operator selected. The same holds
 * for a Codex ChatGPT login file next to `OPENAI_API_KEY`, and a Grok login
 * next to `XAI_API_KEY`.
 *
 * The rule: when a subscription login for a CLI is present, that CLI's agents do
 * not receive the shadowed API-key variables. Other CLIs, and the runner's own
 * API steps, still see them.
 *
 * A worker that materialises login files (agent-relay cloud worker) lists the
 * CLIs in `AGENT_RELAY_SUBSCRIPTION_LOGINS` (comma-separated, e.g.
 * `codex,grok`). A Claude setup token is detected from `CLAUDE_CODE_OAUTH_TOKEN`.
 */
export const SUBSCRIPTION_LOGINS_ENV = 'AGENT_RELAY_SUBSCRIPTION_LOGINS' as const;

type Env = Record<string, string | undefined>;

interface PrecedenceRule {
  cli: string;
  hasSubscription(env: Env, declared: ReadonlySet<string>): boolean;
  shadowed: readonly string[];
}

const nonEmpty = (value: string | undefined) => typeof value === 'string' && value.trim() !== '';

export const SUBSCRIPTION_PRECEDENCE_RULES: readonly PrecedenceRule[] = [
  {
    cli: 'claude',
    hasSubscription: (env, declared) => nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN) || declared.has('claude'),
    shadowed: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  },
  {
    cli: 'codex',
    hasSubscription: (_env, declared) => declared.has('codex'),
    shadowed: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  {
    cli: 'grok',
    hasSubscription: (_env, declared) => declared.has('grok'),
    shadowed: ['XAI_API_KEY'],
  },
];

function declaredLogins(env: Env): Set<string> {
  return new Set(
    (env[SUBSCRIPTION_LOGINS_ENV] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function normalizeCli(cli: string): string {
  const base = cli.trim().toLowerCase().split(/[\\/]/).pop() ?? '';
  return base.split(':')[0] ?? base;
}

/** Variables shadowed for `cli` (every active rule when `cli` is omitted). */
export function shadowedCredentialKeys(env: Env, cli?: string): string[] {
  const declared = declaredLogins(env);
  const target = cli === undefined ? undefined : normalizeCli(cli);
  const keys = new Set<string>();
  for (const rule of SUBSCRIPTION_PRECEDENCE_RULES) {
    if (target !== undefined && rule.cli !== target) continue;
    if (!rule.hasSubscription(env, declared)) continue;
    for (const key of rule.shadowed) {
      if (env[key] !== undefined) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Env for a process that spawns agents of any CLI (the broker): every shadowed
 * key is set to `undefined`, which removes an inherited value when Node spawns
 * the child (omitting the key would let `process.env` leak it back in).
 */
export function brokerCredentialEnv<T extends Env>(env: T): T {
  const result: Env = { ...env };
  for (const key of shadowedCredentialKeys(env)) result[key] = undefined;
  return result as T;
}

/**
 * Overrides for one agent's spawn env. The broker no longer carries the
 * shadowed keys, so an agent whose CLI has no subscription gets them back here;
 * an agent whose CLI has one gets none.
 */
export function agentCredentialEnv(env: Env, cli: string): Record<string, string> {
  const forThisCli = new Set(shadowedCredentialKeys(env, cli));
  const restored: Record<string, string> = {};
  for (const key of shadowedCredentialKeys(env)) {
    const value = env[key];
    if (!forThisCli.has(key) && value !== undefined) restored[key] = value;
  }
  return restored;
}

/** Strips the keys shadowed for `cli` from an env (for direct process spawns). */
export function applySubscriptionPrecedence<T extends Env>(env: T, cli: string): T {
  const result: Env = { ...env };
  for (const key of shadowedCredentialKeys(env, cli)) delete result[key];
  return result as T;
}
