/**
 * CLI registry, binary resolver, and spawn-policy helpers.
 *
 * Vendored from `@agent-relay/sdk` v7 (cli-registry / cli-resolver /
 * spawn-from-env), which dropped these exports in v8 when agent spawning moved
 * to `@agent-relay/harnesses` + `@agent-relay/harness-driver`. Core still needs
 * the CLI metadata, sync binary resolution (e.g. resolving `cursor` to its
 * concrete binary), and the bypass-flag spawn policy, so they live here.
 *
 * Single source of truth for supported agent CLI metadata: binary names,
 * non-interactive args, bypass flags, and well-known install paths.
 */
import { execFileSync } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { accessSync, constants as constantsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Well-known install paths ───────────────────────────────────────────────
/**
 * Common install directories checked when PATH is empty or incomplete.
 * Paths containing `~` are expanded at resolution time.
 */
export const COMMON_SEARCH_PATHS = [
  '~/.local/bin',
  '~/.opencode/bin',
  '~/.claude/local',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/homebrew/bin',
];

export interface CliDefinition {
  /** Binary name(s) to try, in order of preference */
  binaries: string[];
  /** Build non-interactive mode args for a one-shot task */
  nonInteractiveArgs: (task: string, extraArgs?: string[]) => string[];
  /** Bypass flag for auto-approve / unattended mode */
  bypassFlag?: string;
  /** Bypass flag aliases (alternative forms accepted by the CLI) */
  bypassAliases?: string[];
  /** Extra install paths to check beyond PATH (resolved relative to $HOME) */
  searchPaths?: string[];
  /** When true, non-zero exit codes are not treated as failures */
  ignoreExitCode?: boolean;
}

// ── Registry ───────────────────────────────────────────────────────────────
const CLI_REGISTRY: Record<string, CliDefinition> = {
  claude: {
    binaries: ['claude'],
    nonInteractiveArgs: (task, extra = []) => ['-p', '--dangerously-skip-permissions', task, ...extra],
    bypassFlag: '--dangerously-skip-permissions',
    searchPaths: ['~/.claude/local'],
  },
  codex: {
    binaries: ['codex'],
    nonInteractiveArgs: (task, extra = []) => [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      task,
      ...extra,
    ],
    bypassFlag: '--dangerously-bypass-approvals-and-sandbox',
    bypassAliases: ['--full-auto'],
    searchPaths: ['~/.local/bin'],
  },
  gemini: {
    binaries: ['gemini'],
    nonInteractiveArgs: (task, extra = []) => ['-p', task, ...extra],
    bypassFlag: '--yolo',
    bypassAliases: ['-y'],
  },
  opencode: {
    binaries: ['opencode'],
    nonInteractiveArgs: (task, extra = []) => ['run', task, ...extra],
    searchPaths: ['~/.opencode/bin'],
    ignoreExitCode: true,
  },
  droid: {
    binaries: ['droid'],
    nonInteractiveArgs: (task, extra = []) => ['exec', task, ...extra],
  },
  aider: {
    binaries: ['aider'],
    nonInteractiveArgs: (task, extra = []) => ['--message', task, '--yes-always', '--no-git', ...extra],
  },
  goose: {
    binaries: ['goose'],
    nonInteractiveArgs: (task, extra = []) => ['run', '--text', task, '--no-session', ...extra],
  },
  'cursor-agent': {
    binaries: ['cursor-agent'],
    nonInteractiveArgs: (task, extra = []) => ['--force', '-p', task, ...extra],
  },
  agent: {
    binaries: ['agent'],
    nonInteractiveArgs: (task, extra = []) => ['--force', '-p', task, ...extra],
  },
  cursor: {
    binaries: ['cursor-agent', 'agent'],
    nonInteractiveArgs: (task, extra = []) => ['--force', '-p', task, ...extra],
  },
  api: {
    binaries: [],
    nonInteractiveArgs: (task) => [task],
  },
};

/**
 * Get the CLI definition for a given CLI identifier.
 * Handles `cli:model` variants (e.g. `claude:opus`) by extracting the base CLI.
 */
export function getCliDefinition(cli: string): CliDefinition | undefined {
  const baseCli = cli.includes(':') ? cli.split(':')[0] : cli;
  return CLI_REGISTRY[baseCli];
}

/** Get the full registry (read-only). */
export function getCliRegistry(): Readonly<Record<string, CliDefinition>> {
  return CLI_REGISTRY;
}

// ── Binary resolution ────────────────────────────────────────────────────────
export interface ResolvedCli {
  /** The binary name that was found */
  binary: string;
  /** The full path to the binary */
  path: string;
}

// null sentinel means "looked up, not found" — avoids repeating expensive searches
const resolveCache = new Map<string, ResolvedCli | null>();

/** Clear the resolution cache. Useful for testing or after PATH changes. */
export function clearResolveCache(): void {
  resolveCache.clear();
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve a CLI to its binary path. Checks PATH via `which`, then falls back
 * to well-known install directories from the CLI registry. Memoized.
 */
export async function resolveCli(cli: string): Promise<ResolvedCli | undefined> {
  if (resolveCache.has(cli)) {
    return resolveCache.get(cli) ?? undefined;
  }
  const def = getCliDefinition(cli);
  if (!def) return undefined;
  for (const binary of def.binaries) {
    try {
      const { stdout } = await execFileAsync('which', [binary]);
      const path = stdout.trim();
      if (path) {
        const result = { binary, path };
        resolveCache.set(cli, result);
        return result;
      }
    } catch {
      // not in PATH
    }
    const searchDirs = [...(def.searchPaths ?? []), ...COMMON_SEARCH_PATHS];
    const seen = new Set<string>();
    for (const dir of searchDirs) {
      const expanded = expandHome(dir);
      if (seen.has(expanded)) continue;
      seen.add(expanded);
      const candidate = join(expanded, binary);
      try {
        await access(candidate, constants.X_OK);
        const result = { binary, path: candidate };
        resolveCache.set(cli, result);
        return result;
      } catch {
        // not found here
      }
    }
  }
  resolveCache.set(cli, null);
  return undefined;
}

/**
 * Synchronous version of `resolveCli`. Uses `which` via execFileSync and
 * synchronous fs.accessSync. Prefer the async version when possible.
 */
export function resolveCliSync(cli: string): ResolvedCli | undefined {
  if (resolveCache.has(cli)) {
    return resolveCache.get(cli) ?? undefined;
  }
  const def = getCliDefinition(cli);
  if (!def) return undefined;
  for (const binary of def.binaries) {
    try {
      const stdout = execFileSync('which', [binary], { stdio: ['pipe', 'pipe', 'ignore'] });
      const path = stdout.toString().trim();
      if (path) {
        const result = { binary, path };
        resolveCache.set(cli, result);
        return result;
      }
    } catch {
      // not in PATH
    }
    const searchDirs = [...(def.searchPaths ?? []), ...COMMON_SEARCH_PATHS];
    const seen = new Set<string>();
    for (const dir of searchDirs) {
      const expanded = expandHome(dir);
      if (seen.has(expanded)) continue;
      seen.add(expanded);
      const candidate = join(expanded, binary);
      try {
        accessSync(candidate, constantsSync.X_OK);
        const result = { binary, path: candidate };
        resolveCache.set(cli, result);
        return result;
      } catch {
        // not found here
      }
    }
  }
  resolveCache.set(cli, null);
  return undefined;
}

// ── Spawn policy ──────────────────────────────────────────────────────────────
export interface SpawnEnvInput {
  AGENT_NAME: string;
  AGENT_CLI: string;
  RELAY_API_KEY: string;
  AGENT_TASK?: string;
  /** JSON array preferred, space-delimited fallback */
  AGENT_ARGS?: string;
  AGENT_CWD?: string;
  /** Comma-separated channel list, defaults to "general" */
  AGENT_CHANNELS?: string;
  RELAY_BASE_URL?: string;
  BROKER_BINARY_PATH?: string;
  /** Model override (e.g. "opus", "sonnet") */
  AGENT_MODEL?: string;
  /** "1" disables SDK default bypass flags */
  AGENT_DISABLE_DEFAULT_BYPASS?: string;
}

export interface SpawnPolicyResult {
  name: string;
  cli: string;
  args: string[];
  channels: string[];
  task?: string;
  cwd?: string;
  model?: string;
  bypassApplied: boolean;
}

/** Resolve bypass flag config for a CLI from the consolidated registry. */
function getBypassFlagConfig(cli: string): { flag: string; aliases?: string[] } | undefined {
  const def = getCliDefinition(cli);
  if (!def?.bypassFlag) return undefined;
  return { flag: def.bypassFlag, aliases: def.bypassAliases };
}

/** Parse extra args from env. Supports JSON array or space-delimited string. */
function parseArgs(raw?: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to space-delimited
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Resolve the full spawn policy from parsed env input.
 * Applies bypass flags unless disabled or already present.
 */
export function resolveSpawnPolicy(input: SpawnEnvInput): SpawnPolicyResult {
  const extraArgs = parseArgs(input.AGENT_ARGS);
  const channels = input.AGENT_CHANNELS
    ? input.AGENT_CHANNELS.split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : ['general'];
  const disableBypass = input.AGENT_DISABLE_DEFAULT_BYPASS === '1';
  const bypassConfig = getBypassFlagConfig(input.AGENT_CLI);
  let bypassApplied = false;
  const args = [...extraArgs];
  const bypassValues = bypassConfig ? [bypassConfig.flag, ...(bypassConfig.aliases ?? [])] : [];
  const hasBypassAlready = bypassValues.some((value) => args.includes(value));
  if (bypassConfig && !disableBypass && !hasBypassAlready) {
    args.push(bypassConfig.flag);
    bypassApplied = true;
  }
  return {
    name: input.AGENT_NAME,
    cli: input.AGENT_CLI,
    args,
    channels,
    task: input.AGENT_TASK,
    cwd: input.AGENT_CWD,
    model: input.AGENT_MODEL,
    bypassApplied,
  };
}
