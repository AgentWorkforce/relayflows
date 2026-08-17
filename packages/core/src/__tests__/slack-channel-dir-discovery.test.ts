/**
 * Deriving the Slack channel directory that inbound replies arrive in.
 *
 * Relayfile materializes a channel under BOTH `<id>` and `<id>__<name>`, and
 * delivers inbound messages and thread replies to the suffixed one. The existing
 * subscription code slugified whatever identifier the caller passed: correct for a
 * channel NAME, useless for a channel ID (the documented alternative), since
 * slugifying `C0B9Z4CLG1J` yields `C0B9Z4CLG1J__c0b9z4clg1j`.
 *
 * Real failure this covers: a gate asked in `C0B9Z4CLG1J`, a human replied
 * correctly in-thread 71s later, and the answer was never observed. The run watched
 * `/slack/channels/C0B9Z4CLG1J/**` (30 entries, newest 2026-07-10) while the reply
 * landed in `/slack/channels/C0B9Z4CLG1J__watchdog-test/**` (281 entries, current).
 *
 * The title now comes from the synced channel index (`id -> title`), so the suffix
 * is derived from data rather than guessed from the caller's input.
 */
import { describe, it, expect } from 'vitest';
import { slackChannelTitleSlug, slackSuffixedChannelPath } from '../runner.js';

const ID = 'C0B9Z4CLG1J';

describe('slackChannelTitleSlug', () => {
  it('slugifies a channel title the way Relayfile names its directories', () => {
    expect(slackChannelTitleSlug('watchdog-test')).toBe('watchdog-test');
    expect(slackChannelTitleSlug('proj-relay-core')).toBe('proj-relay-core');
  });

  it('normalises case, spaces, #, and punctuation', () => {
    expect(slackChannelTitleSlug('#Ops NightCTO Notifications')).toBe('ops-nightcto-notifications');
    expect(slackChannelTitleSlug('  GTM / Marketing  ')).toBe('gtm-marketing');
  });

  it('collapses runs of separators and trims them from the ends', () => {
    expect(slackChannelTitleSlug('--a__b  c--')).toBe('a-b-c');
  });

  it('returns an empty string for a title with nothing slug-worthy', () => {
    expect(slackChannelTitleSlug('   ')).toBe('');
    expect(slackChannelTitleSlug('###')).toBe('');
  });
});

describe('slackSuffixedChannelPath', () => {
  it('builds the path replies actually arrive in', () => {
    // The exact case that broke: id + real title from the index.
    expect(slackSuffixedChannelPath(ID, 'watchdog-test')).toBe(
      `/slack/channels/${ID}__watchdog-test/**`
    );
  });

  it('is undefined without a title, rather than fabricating a path', () => {
    // Subscribing to a guessed directory is what caused the original failure, so
    // the absence of a title must surface as "unknown", not as a wrong path.
    expect(slackSuffixedChannelPath(ID, undefined)).toBeUndefined();
    expect(slackSuffixedChannelPath(ID, '')).toBeUndefined();
    expect(slackSuffixedChannelPath(ID, '   ')).toBeUndefined();
  });

  it('never reproduces the old id-slugified guess', () => {
    // Regression guard: `C0B9Z4CLG1J__c0b9z4clg1j` is the path that does not exist.
    expect(slackSuffixedChannelPath(ID, 'watchdog-test')).not.toContain('c0b9z4clg1j');
  });

  it('tolerates a leading # and whitespace on the id', () => {
    expect(slackSuffixedChannelPath(`  #${ID} `, 'watchdog-test')).toBe(
      `/slack/channels/${ID}__watchdog-test/**`
    );
  });

  it('is undefined for an empty id', () => {
    expect(slackSuffixedChannelPath('', 'watchdog-test')).toBeUndefined();
    expect(slackSuffixedChannelPath('   ', 'watchdog-test')).toBeUndefined();
  });

  it('slugifies a title that needs normalising', () => {
    expect(slackSuffixedChannelPath('C0BAYBD2QDT', 'Ops NightCTO Notifications')).toBe(
      '/slack/channels/C0BAYBD2QDT__ops-nightcto-notifications/**'
    );
  });
});
