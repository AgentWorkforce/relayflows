import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface RepairScopeViolation {
  path: string;
  reason: string;
  expectedType: ProtectedNodeType;
  actualType: ProtectedNodeType;
  expectedSha256: string;
  actualSha256: string;
  expectedCanonicalPath: string;
  actualCanonicalPath: string;
  restoreError?: string;
}

export class RepairScopeViolationError extends Error {
  constructor(public readonly violations: RepairScopeViolation[]) {
    super(
      `Repair scope violation: ${violations
        .map((violation) => `${violation.path} (${violation.reason})`)
        .join(', ')}`
    );
    this.name = 'RepairScopeViolationError';
  }
}

export type ProtectedNodeType = 'absent' | 'file' | 'directory' | 'symlink' | 'other' | 'cycle';

interface ProtectedNode {
  type: ProtectedNodeType;
  mode: number;
  bytes?: Buffer;
  linkTarget?: string;
  canonicalPath?: string;
  entries?: Array<{ name: string; node: ProtectedNode }>;
  sha256: string;
}

interface ProtectedPathSnapshot {
  requestedPath: string;
  canonicalPath: string;
  logicalType: ProtectedNodeType;
  logicalMode: number;
  logicalLinkTarget?: string;
  node: ProtectedNode;
}

const modeBits = (mode: number): number => mode & 0o7777;

// Codes that mean "this path cannot be resolved as it stands" rather than a
// real I/O failure. A repair that plants a symlink cycle (ELOOP) or replaces a
// parent directory with a file (ENOTDIR) must surface as a violation to
// restore, not as a thrown error that skips the restore path entirely.
const UNRESOLVABLE_PATH_CODES = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'ENAMETOOLONG']);
const digest = (chunks: Array<string | Buffer>): string => {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
};

function nodeType(filePath: string): { type: ProtectedNodeType; mode: number; linkTarget?: string } {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink()) {
      return { type: 'symlink', mode: modeBits(info.mode), linkTarget: readlinkSync(filePath) };
    }
    if (info.isFile()) return { type: 'file', mode: modeBits(info.mode) };
    if (info.isDirectory()) return { type: 'directory', mode: modeBits(info.mode) };
    return { type: 'other', mode: modeBits(info.mode) };
  } catch (error) {
    if (UNRESOLVABLE_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      return { type: 'absent', mode: 0 };
    }
    throw error;
  }
}

/** Make every ancestor of `filePath` a real directory, removing any symlink or
 *  non-directory a repair may have planted, so restore/removal operations act
 *  on the canonical location instead of following a mutable parent elsewhere. */
function ensureRealParentChain(filePath: string): void {
  const parentPath = path.dirname(filePath);
  if (parentPath === filePath) return;
  const root = path.parse(parentPath).root;
  const parts = parentPath.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info: ReturnType<typeof lstatSync> | undefined;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if (!UNRESOLVABLE_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (!info) {
      mkdirSync(cursor);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      rmSync(cursor, { recursive: true, force: true });
      mkdirSync(cursor);
    }
  }
}

/** Resolve every existing symlink component, including for a path that is currently absent. */
export function canonicalizeProtectedPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (!UNRESOLVABLE_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }

  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(path.basename(cursor));
    cursor = parent;
    try {
      return path.join(realpathSync.native(cursor), ...missing);
    } catch (error) {
      if (!UNRESOLVABLE_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
}

function captureNode(filePath: string, ancestors = new Set<string>()): ProtectedNode {
  const meta = nodeType(filePath);
  if (meta.type === 'absent') {
    return { type: 'absent', mode: 0, sha256: digest(['absent']) };
  }

  if (meta.type === 'symlink') {
    const canonicalPath = canonicalizeProtectedPath(filePath);
    if (ancestors.has(canonicalPath)) {
      return {
        type: 'cycle',
        mode: meta.mode,
        linkTarget: meta.linkTarget,
        canonicalPath,
        sha256: digest(['cycle', meta.linkTarget ?? '', canonicalPath]),
      };
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(canonicalPath);
    const target = captureNode(canonicalPath, nextAncestors);
    return {
      type: 'symlink',
      mode: meta.mode,
      bytes: Buffer.from(meta.linkTarget ?? ''),
      linkTarget: meta.linkTarget,
      canonicalPath,
      entries: [{ name: '<target>', node: target }],
      sha256: digest(['symlink', String(meta.mode), meta.linkTarget ?? '', canonicalPath, target.sha256]),
    };
  }

  if (meta.type === 'file') {
    const bytes = readFileSync(filePath);
    return {
      type: 'file',
      mode: meta.mode,
      bytes,
      sha256: digest(['file', String(meta.mode), bytes]),
    };
  }

  if (meta.type === 'directory') {
    const entries = readdirSync(filePath)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, node: captureNode(path.join(filePath, name), ancestors) }));
    return {
      type: 'directory',
      mode: meta.mode,
      entries,
      sha256: digest([
        'directory',
        String(meta.mode),
        ...entries.flatMap(({ name, node }) => [name, node.type, node.sha256]),
      ]),
    };
  }

  return { type: 'other', mode: meta.mode, sha256: digest(['other', String(meta.mode)]) };
}

function restoreNode(filePath: string, node: ProtectedNode, restoredTargets = new Set<string>()): void {
  // A repair may have swapped an ancestor directory for a symlink; every
  // rm/write below would silently follow it to an external target otherwise.
  ensureRealParentChain(filePath);

  if (node.type === 'absent') {
    rmSync(filePath, { recursive: true, force: true });
    return;
  }

  if (node.type === 'cycle') return;

  if (node.type === 'symlink') {
    const targetNode = node.entries?.[0]?.node;
    if (node.canonicalPath && targetNode && !restoredTargets.has(node.canonicalPath)) {
      restoredTargets.add(node.canonicalPath);
      restoreNode(node.canonicalPath, targetNode, restoredTargets);
    }
    rmSync(filePath, { recursive: true, force: true });
    symlinkSync(node.linkTarget ?? '', filePath);
    return;
  }

  rmSync(filePath, { recursive: true, force: true });
  if (node.type === 'file') {
    writeFileSync(filePath, node.bytes ?? Buffer.alloc(0));
    chmodSync(filePath, node.mode);
    return;
  }
  if (node.type === 'directory') {
    mkdirSync(filePath, { recursive: true });
    for (const entry of node.entries ?? []) {
      restoreNode(path.join(filePath, entry.name), entry.node, restoredTargets);
    }
    chmodSync(filePath, node.mode);
    return;
  }
  throw new Error(`Cannot restore unsupported protected path type at ${filePath}`);
}

function capturePath(requestedPath: string): ProtectedPathSnapshot {
  const absolute = path.resolve(requestedPath);
  const logical = nodeType(absolute);
  const canonicalPath = canonicalizeProtectedPath(absolute);
  return {
    requestedPath: absolute,
    canonicalPath,
    logicalType: logical.type,
    logicalMode: logical.mode,
    logicalLinkTarget: logical.linkTarget,
    node: captureNode(canonicalPath),
  };
}

export class RepairProtectionSnapshot {
  private constructor(private readonly paths: ProtectedPathSnapshot[]) {}

  static capture(protectedPaths: string[]): RepairProtectionSnapshot {
    const uniquePaths = [...new Set(protectedPaths.map((filePath) => path.resolve(filePath)))];
    return new RepairProtectionSnapshot(uniquePaths.map(capturePath));
  }

  verifyAndRestore(): RepairScopeViolation[] {
    const violations: RepairScopeViolation[] = [];
    for (const expected of this.paths) {
      const actual = capturePath(expected.requestedPath);
      const reasons: string[] = [];
      if (expected.logicalType !== actual.logicalType) {
        reasons.push(`type changed from ${expected.logicalType} to ${actual.logicalType}`);
      }
      if (expected.logicalMode !== actual.logicalMode) {
        reasons.push(
          `mode changed from ${expected.logicalMode.toString(8)} to ${actual.logicalMode.toString(8)}`
        );
      }
      if (expected.logicalLinkTarget !== actual.logicalLinkTarget) {
        reasons.push('symlink target changed');
      }
      if (expected.canonicalPath !== actual.canonicalPath) {
        reasons.push(`canonical target changed from ${expected.canonicalPath} to ${actual.canonicalPath}`);
      }
      if (expected.node.sha256 !== actual.node.sha256) reasons.push('SHA-256 changed');
      if (reasons.length === 0) continue;

      const violation: RepairScopeViolation = {
        path: expected.requestedPath,
        reason: reasons.join('; '),
        expectedType: expected.logicalType,
        actualType: actual.logicalType,
        expectedSha256: expected.node.sha256,
        actualSha256: actual.node.sha256,
        expectedCanonicalPath: expected.canonicalPath,
        actualCanonicalPath: actual.canonicalPath,
      };
      try {
        restoreNode(expected.canonicalPath, expected.node);
        if (expected.logicalType === 'absent') {
          ensureRealParentChain(expected.requestedPath);
          rmSync(expected.requestedPath, { recursive: true, force: true });
        } else if (expected.logicalType === 'symlink') {
          ensureRealParentChain(expected.requestedPath);
          rmSync(expected.requestedPath, { recursive: true, force: true });
          symlinkSync(expected.logicalLinkTarget ?? '', expected.requestedPath);
        } else if (
          actual.logicalType === 'symlink' ||
          expected.canonicalPath !== actual.canonicalPath
        ) {
          restoreNode(expected.requestedPath, expected.node);
        }
      } catch (error) {
        violation.restoreError = error instanceof Error ? error.message : String(error);
      }
      violations.push(violation);
    }
    return violations;
  }
}
