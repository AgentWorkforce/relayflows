import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import ignore from 'ignore';

import type {
  AccessPreset,
  AgentPermissions,
  CompiledAgentPermissions,
  PermissionSource,
} from '../types.js';

export type { AgentPermissions, CompiledAgentPermissions } from '../types.js';

export interface LocalJwksSigningKey {
  kid: string;
  privateKey: KeyObject;
}

export interface CompileAgentScopesOptions {
  agentName: string;
  workspace: string;
  projectDir: string;
  permissions?: AgentPermissions;
}

export const DEFAULT_ADMIN_AGENT_NAME = 'relay-admin';
export const DEFAULT_ADMIN_SCOPES = ['relayfile:admin:*'];
export const RELAYAUTH_JWT_PRIVATE_KEY_PEM_ENV = 'RELAYAUTH_JWT_PRIVATE_KEY_PEM';
export const RELAYAUTH_JWT_KID_ENV = 'RELAYAUTH_JWT_KID';

type AuditAction = 'resolve' | 'mint' | 'seed';

interface AuditEntry {
  agentName: string;
  action: AuditAction;
  details: Record<string, unknown>;
  timestamp: string;
}

function walkFiles(root: string, directory = ''): string[] {
  const absoluteDirectory = path.join(root, directory);
  const entries = readdirSync(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.relay') {
      continue;
    }

    const relativePath = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function readDotfilePatterns(projectDir: string, filename: string): string[] {
  try {
    return readFileSync(path.join(projectDir, filename), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function matchingFiles(files: readonly string[], patterns: readonly string[]): string[] {
  if (patterns.length === 0) {
    return [];
  }

  const matcher = ignore().add([...patterns]);
  return files.filter((file) => matcher.ignores(file));
}

function toScopes(kind: 'read' | 'write', files: readonly string[]): string[] {
  return files.map((file) => `relayfile:fs:${kind}:/${file}`);
}

function buildAcl(readonlyPaths: readonly string[], readwritePaths: readonly string[]): Record<string, string[]> {
  const acl: Record<string, string[]> = {};

  for (const file of readonlyPaths) {
    const directory = path.posix.dirname(file) === '.' ? '/' : `/${path.posix.dirname(file)}`;
    acl[directory] = [...(acl[directory] ?? []), 'read'];
  }

  for (const file of readwritePaths) {
    const directory = path.posix.dirname(file) === '.' ? '/' : `/${path.posix.dirname(file)}`;
    acl[directory] = [...new Set([...(acl[directory] ?? []), 'read', 'write'])];
  }

  return acl;
}

export function compileAgentScopes(options: CompileAgentScopesOptions): CompiledAgentPermissions {
  const permissions = options.permissions ?? {};
  const access: AccessPreset = permissions.access ?? 'readwrite';
  const files = walkFiles(options.projectDir);
  const inherit = access === 'full' ? false : permissions.inherit ?? true;
  const inheritedDenyPatterns = inherit ? readDotfilePatterns(options.projectDir, '.agentignore') : [];
  const inheritedReadonlyPatterns = inherit ? readDotfilePatterns(options.projectDir, '.agentreadonly') : [];
  const yamlReadPatterns = permissions.files?.read ?? [];
  const yamlWritePatterns = permissions.files?.write ?? [];
  const yamlDenyPatterns = permissions.files?.deny ?? [];

  const inheritedDeniedSet = new Set(matchingFiles(files, inheritedDenyPatterns));
  const yamlDeniedSet = new Set(matchingFiles(files, yamlDenyPatterns));
  const yamlAllowedSet = new Set([
    ...matchingFiles(files, yamlReadPatterns),
    ...matchingFiles(files, yamlWritePatterns),
  ]);
  const deniedSet = new Set<string>();
  for (const file of files) {
    if (yamlDeniedSet.has(file) || (inheritedDeniedSet.has(file) && !yamlAllowedSet.has(file))) {
      deniedSet.add(file);
    }
  }
  const deniedPatterns = [...inheritedDenyPatterns, ...yamlDenyPatterns];
  const readonlySet = new Set<string>();
  const readwriteSet = new Set<string>();

  if (access === 'full' || access === 'readwrite') {
    for (const file of files) {
      if (!deniedSet.has(file)) {
        readwriteSet.add(file);
      }
    }
  } else if (access === 'readonly') {
    for (const file of files) {
      if (!deniedSet.has(file)) {
        readonlySet.add(file);
      }
    }
  }

  for (const file of matchingFiles(files, inheritedReadonlyPatterns)) {
    if (!deniedSet.has(file)) {
      readwriteSet.delete(file);
      readonlySet.add(file);
    }
  }

  for (const file of yamlAllowedSet) {
    if (!deniedSet.has(file) && !readwriteSet.has(file)) {
      readonlySet.add(file);
    }
  }

  for (const file of matchingFiles(files, yamlWritePatterns)) {
    if (!deniedSet.has(file)) {
      readonlySet.delete(file);
      readwriteSet.add(file);
    }
  }

  const readonlyPaths = [...readonlySet].sort((left, right) => left.localeCompare(right));
  const readwritePaths = [...readwriteSet].sort((left, right) => left.localeCompare(right));
  const deniedPaths = [...deniedSet].sort((left, right) => left.localeCompare(right));
  const scopes = [
    ...toScopes('read', readonlyPaths),
    ...toScopes('read', readwritePaths),
    ...toScopes('write', readwritePaths),
    ...(permissions.scopes ?? []),
  ];
  const sources: PermissionSource[] = [];

  if (inheritedDenyPatterns.length > 0) {
    sources.push({ type: 'dotfile', label: '.agentignore', ruleCount: inheritedDenyPatterns.length });
  }
  if (inheritedReadonlyPatterns.length > 0) {
    sources.push({ type: 'dotfile', label: '.agentreadonly', ruleCount: inheritedReadonlyPatterns.length });
  }
  sources.push({ type: 'preset', label: `access: ${access}`, ruleCount: 1 });
  if (yamlReadPatterns.length + yamlWritePatterns.length + yamlDenyPatterns.length > 0) {
    sources.push({
      type: 'yaml',
      label: 'permissions.files',
      ruleCount: yamlReadPatterns.length + yamlWritePatterns.length + yamlDenyPatterns.length,
    });
  }
  if ((permissions.scopes ?? []).length > 0) {
    sources.push({ type: 'scope', label: 'permissions.scopes', ruleCount: permissions.scopes!.length });
  }

  return {
    agentName: options.agentName,
    workspace: options.workspace,
    effectiveAccess: access,
    inherited: inherit,
    sources,
    readonlyPatterns: [...inheritedReadonlyPatterns, ...yamlReadPatterns],
    readwritePatterns: access === 'readwrite' || access === 'full' ? ['**/*'] : [...yamlWritePatterns],
    deniedPatterns,
    readonlyPaths,
    readwritePaths,
    deniedPaths,
    scopes,
    network: permissions.network,
    exec: permissions.exec,
    acl: buildAcl(readonlyPaths, readwritePaths),
    summary: {
      readonly: readonlyPaths.length,
      readwrite: readwritePaths.length,
      denied: deniedPaths.length,
      customScopes: permissions.scopes?.length ?? 0,
    },
  };
}

export function resolveAgentPermissions(
  agentName: string,
  permissions: AgentPermissions | undefined,
  projectDir: string,
  workspace: string
): CompiledAgentPermissions {
  return compileAgentScopes({ agentName, workspace, projectDir, permissions });
}

export function getDefaultPermissionAuditPath(projectDir: string): string {
  return path.join(projectDir, '.agent-relay', 'permission-audit.json');
}

export class PermissionAuditLog {
  private readonly entries: AuditEntry[] = [];

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    this.entries.push({ ...entry, timestamp: new Date().toISOString() });
  }

  async writeTo(filePath: string): Promise<void> {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ entries: this.entries }, null, 2) + '\n');
  }

  summary(): string {
    return `Permission audit: ${this.entries.length} entries`;
  }
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

export function mintAgentToken(options: {
  privateKey: KeyObject;
  kid: string;
  agentName: string;
  workspace: string;
  scopes: readonly string[];
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: options.kid };
  const payload = {
    sub: options.agentName,
    agent: options.agentName,
    workspace: options.workspace,
    scopes: options.scopes,
    iat: now,
    exp: now + (options.ttlSeconds ?? 7200),
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), options.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function createLocalJwksKeyPair(kid = 'local-relayauth-key'): LocalJwksSigningKey {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey };
}

export function importPrivateKeyPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}
