/**
 * A failing step's output is the most useful thing in the run, and it used to be
 * thrown away.
 *
 * Real case this covers: a `review-preq` lane was handed a diff, wrote a
 * considered rejection of a genuine memory-exhaustion DoS, and ended with
 * `PREQ: FAIL <reason>`. Verification wanted `PREQ: PASS`, so the step failed —
 * and because output was only persisted and logged for COMPLETED steps, all the
 * operator saw was:
 *
 *     Verification failed for "review-preq": output does not contain "PREQ: PASS"
 *
 * which reads exactly like the agent returned nothing. The verdict was recoverable
 * only from a raw worker log. Distinguishing "produced nothing" from "produced a
 * considered answer that wasn't the token" is the whole point here.
 */
import { describe, it, expect } from 'vitest';
import { describeOutputForFailure, runVerification } from '../verification.js';
import { scrubSecrets } from '../channel-messenger.js';

const PREQ_VERDICT = `### Verdict rationale
The lockout logic is correctly implemented and meaningfully tested. However, the
diff introduces an unbounded \`Map\` keyed by attacker-controlled, unauthenticated
input, with cleanup that only triggers on repeat lookups of the same key.

PREQ: FAIL unbounded \`failedLogins\` Map keyed by attacker-controlled usernames allows indefinite memory growth`;

describe('describeOutputForFailure', () => {
  it('says so explicitly when the step produced nothing', () => {
    for (const empty of ['', '   ', '\n\n']) {
      expect(describeOutputForFailure(empty)).toContain('produced no output');
    }
  });

  it('reports the length and quotes the tail, where a verdict marker would be', () => {
    const described = describeOutputForFailure(PREQ_VERDICT);
    expect(described).toContain('PREQ: FAIL');
    expect(described).toContain('unbounded');
    expect(described).toMatch(/produced \d+ chars/);
    expect(described).not.toContain('produced no output');
  });

  it('truncates a long output from the front, keeping the end', () => {
    const long = `${'x'.repeat(5000)}TAIL_MARKER`;
    const described = describeOutputForFailure(long);
    expect(described).toContain('TAIL_MARKER');
    expect(described).toContain('…');
    expect(described.length).toBeLessThan(700);
  });

  it('scrubs secrets, because this message reaches the log and the channel', () => {
    const key = `sk-ant-api03-${'a'.repeat(95)}`;
    expect(describeOutputForFailure(`checking token ${key} done`)).not.toContain(key);
  });
});

describe('output_contains failure message', () => {
  const check = { type: 'output_contains' as const, value: 'PREQ: PASS' };

  function failureMessage(output: string): string {
    try {
      runVerification(check, output, 'review-preq');
      throw new Error('expected verification to fail');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it('shows the rejection instead of implying the step returned nothing', () => {
    const message = failureMessage(PREQ_VERDICT);
    expect(message).toContain('output does not contain "PREQ: PASS"');
    // The half that was missing, and the reason this took hours to diagnose.
    expect(message).toContain('PREQ: FAIL');
  });

  it('still distinguishes a genuinely empty output', () => {
    expect(failureMessage('')).toContain('produced no output');
  });

  it('does not fire when the token is present', () => {
    expect(() =>
      runVerification(check, 'all four checks passed\nPREQ: PASS', 'review-preq')
    ).not.toThrow();
  });
});


/**
 * Widening what reaches the channel is only safe if the scrubber actually covers
 * the keys that show up here. It did not: the body pattern was `[a-zA-Z0-9]{20,}`,
 * which stops at the first hyphen, so `sk-ant-api03-…` matched only as far as
 * `ant` and was emitted in full. Anthropic and OpenAI keys are the two most likely
 * to appear in this codebase's agent output.
 */
describe('scrubSecrets covers hyphenated vendor key prefixes', () => {
  const cases: Array<[string, string]> = [
    ['anthropic', `sk-ant-api03-${'a'.repeat(95)}`],
    ['openai project', `sk-proj-${'b'.repeat(48)}`],
    ['openai legacy', `sk-${'c'.repeat(48)}`],
    ['slack bot', 'xoxb-123456789012-abcdefghijkl'],
    ['github pat', `ghp_${'d'.repeat(36)}`],
    ['relay live', `rk_live_${'e'.repeat(32)}`],
  ];

  for (const [name, key] of cases) {
    it(`redacts a ${name} key`, () => {
      const scrubbed = scrubSecrets(`token ${key} end`);
      expect(scrubbed).not.toContain(key);
      expect(scrubbed).toContain('[REDACTED]');
    });
  }

  it('leaves ordinary hyphenated prose alone', () => {
    // A `\b` guard keeps `ask-`/`task-` from matching on their `sk-` tail — the
    // false positive the widened body would otherwise introduce.
    for (const prose of [
      'ask-someone-about-this-topic-here',
      'task-oriented-workflow-naming-x',
      'sk-not-a-key',
    ]) {
      expect(scrubSecrets(prose)).not.toContain('[REDACTED]');
    }
  });
});
