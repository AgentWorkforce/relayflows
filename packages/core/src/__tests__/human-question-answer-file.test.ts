/**
 * The on-disk question/answer loop — the half that was never built.
 *
 * Blocked steps already wrote `questions/<step>.md` and DM'd chief. Nothing ever
 * read the reply. On 2026-08-25 chief answered `program-lead-coordinate` on disk
 * within minutes while the run spent the full hour timing out on a Slack round
 * trip for the same question, then died on the next one. The answer had been
 * sitting unread the whole time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowRunner } from '../runner.js';
import type { FileHumanAssistanceConfig, HumanAssistanceConfig, WorkflowStep } from '../schema.js';

type Injected = { agentName: string; stepName: string; source: string; text: string };

type RunnerInternals = {
  activeAgentHandles: Map<string, unknown>;
  consumedAnswerFiles: Set<string>;
  askViaAnswerFileAndInject(
    agentName: string,
    step: WorkflowStep,
    config: FileHumanAssistanceConfig,
    question: string
  ): Promise<void>;
  isSlackHumanAssistanceEnabled(config: HumanAssistanceConfig | undefined): boolean;
  resolveFileHumanAssistanceConfig(config: HumanAssistanceConfig | undefined): FileHumanAssistanceConfig | undefined;
  injectAnswerToAgent(input: Injected): Promise<void>;
  log(message: string): void;
  postToChannel(message: string): unknown;
};

const STEP = { name: 'program-lead-coordinate' } as WorkflowStep;

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'answer-file-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workdir, { recursive: true, force: true });
});

function harness(): { runner: WorkflowRunner; r: RunnerInternals; injected: Injected[] } {
  const runner = new WorkflowRunner({ cwd: workdir });
  const r = runner as unknown as RunnerInternals;
  const injected: Injected[] = [];
  vi.spyOn(r, 'log').mockImplementation(() => undefined);
  vi.spyOn(r, 'postToChannel').mockImplementation(() => undefined);
  vi.spyOn(r, 'injectAnswerToAgent').mockImplementation(async (input: Injected) => {
    injected.push(input);
  });
  r.activeAgentHandles.set('program-lead-a96090b1', {});
  return { runner, r, injected };
}

const CONFIG: FileHumanAssistanceConfig = {
  dir: '.workflow-artifacts/sandbox-program/questions',
  pollIntervalMs: 10,
  timeoutMs: 3_000,
};

describe('askViaAnswerFileAndInject', () => {
  it('injects an answer that was already waiting on disk', async () => {
    const { r, injected } = harness();
    const dir = path.join(workdir, CONFIG.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'program-lead-coordinate.ANSWER.md'), '# ANSWER — chief\n\nD3 stands as written.\n');

    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, CONFIG, 'Is D3 still binding?');

    expect(injected).toHaveLength(1);
    expect(injected[0]!.source).toBe('file');
    expect(injected[0]!.agentName).toBe('program-lead-a96090b1');
    expect(injected[0]!.text).toContain('HUMAN_ANSWER:');
    expect(injected[0]!.text).toContain('D3 stands as written.');
  });

  it('injects an answer that appears while it is waiting', async () => {
    const { r, injected } = harness();
    const dir = path.join(workdir, CONFIG.dir);
    await mkdir(dir, { recursive: true });

    const waiting = r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, CONFIG, 'Is D3 still binding?');
    setTimeout(() => {
      void writeFile(path.join(dir, 'program-lead-coordinate.ANSWER.md'), 'Revert the gate.');
    }, 50);
    await waiting;

    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain('Revert the gate.');
  });

  it('records the question so a human can see what is being asked', async () => {
    const { r } = harness();

    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, { ...CONFIG, timeoutMs: 30 }, 'Is D3 binding?');

    const recorded = await readFile(
      path.join(workdir, CONFIG.dir, 'program-lead-coordinate.md'),
      'utf-8'
    );
    expect(recorded).toContain('Is D3 binding?');
    expect(recorded).toContain('program-lead-coordinate.ANSWER.md');
  });

  it("does not overwrite the agent's own richer question file", async () => {
    const { r } = harness();
    const dir = path.join(workdir, CONFIG.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'program-lead-coordinate.md'), 'THE AGENT WROTE THIS, WITH EVIDENCE');

    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, { ...CONFIG, timeoutMs: 30 }, 'short version');

    const recorded = await readFile(path.join(dir, 'program-lead-coordinate.md'), 'utf-8');
    expect(recorded).toBe('THE AGENT WROTE THIS, WITH EVIDENCE');
  });

  it('returns without injecting when no answer arrives, instead of hanging', async () => {
    const { r, injected } = harness();

    const started = Date.now();
    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, { ...CONFIG, timeoutMs: 120 }, 'unanswerable');

    expect(injected).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('does not hand a second question the first question’s answer', async () => {
    const { r, injected } = harness();
    const dir = path.join(workdir, CONFIG.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'program-lead-coordinate.ANSWER.md'), 'D3 stands.');

    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, CONFIG, 'first');
    expect(injected).toHaveLength(1);

    // Same file, unchanged: it is the previous ruling, not a reply to this one.
    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, { ...CONFIG, timeoutMs: 80 }, 'second');
    expect(injected).toHaveLength(1);
  });

  it('stops waiting once the asking agent is gone', async () => {
    const { r, injected } = harness();
    r.activeAgentHandles.delete('program-lead-a96090b1');

    const started = Date.now();
    await r.askViaAnswerFileAndInject('program-lead-a96090b1', STEP, { ...CONFIG, timeoutMs: 60_000 }, 'q');

    expect(injected).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('channel selection', () => {
  it('turns Slack off whenever the on-disk loop is configured', () => {
    const { r } = harness();
    const config: HumanAssistanceConfig = { slack: { channel: 'proj-cloud' }, file: CONFIG };

    expect(r.resolveFileHumanAssistanceConfig(config)).toEqual(CONFIG);
    expect(r.isSlackHumanAssistanceEnabled(config)).toBe(false);
  });

  it('honours the environment kill switch even with no file loop configured', () => {
    const { r } = harness();
    const config: HumanAssistanceConfig = { slack: { channel: 'proj-cloud' } };
    expect(r.isSlackHumanAssistanceEnabled(config)).toBe(true);

    vi.stubEnv('RELAYFLOWS_DISABLE_SLACK_HUMAN_ASSISTANCE', '1');
    try {
      expect(r.isSlackHumanAssistanceEnabled(config)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
