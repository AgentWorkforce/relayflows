import { postMessage } from './post-message.js';
import type {
  AskQuestionOutput,
  AskQuestionParams,
  SlackConversationMessage,
  SlackReplySummary,
  SlackWebApiLike,
} from '../types.js';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_LIMIT = 100;

/**
 * Post a question to Slack and wait for the first reply in its thread.
 * @param slack - Slack Web API client.
 * @param params - Question and wait parameters.
 * @returns Posted question metadata plus the selected reply.
 */
export async function askQuestion(
  slack: SlackWebApiLike,
  params: AskQuestionParams
): Promise<AskQuestionOutput> {
  if (!slack.conversations.replies) {
    throw new Error('Slack conversations.replies is required to wait for human replies.');
  }

  const question = await postMessage(slack, params);
  const timeoutMs = normalizeNonNegative(params.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const pollIntervalMs = normalizePositive(params.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
  const deadline = Date.now() + timeoutMs;
  const ignoredUsers = new Set(params.ignoreUserIds ?? []);

  while (Date.now() <= deadline) {
    const answer = await findFirstReply(slack, {
      channel: question.channel,
      threadTs: question.ts,
      ignoredUsers,
    });
    if (answer) {
      return { question, answer };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error(
    `Timed out waiting ${timeoutMs}ms for a Slack reply in ${question.channel} thread ${question.ts}`
  );
}

async function findFirstReply(
  slack: SlackWebApiLike,
  input: { channel: string; threadTs: string; ignoredUsers: Set<string> }
): Promise<SlackReplySummary | undefined> {
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.replies!({
      channel: input.channel,
      ts: input.threadTs,
      cursor,
      limit: DEFAULT_PAGE_LIMIT,
    });

    if (response.ok === false) {
      throw new Error(`Slack conversations.replies failed: ${response.error ?? 'unknown_error'}`);
    }

    for (const message of response.messages ?? []) {
      const reply = toReply(message, input);
      if (reply) return reply;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return undefined;
}

function toReply(
  message: SlackConversationMessage,
  input: { threadTs: string; ignoredUsers: Set<string> }
): SlackReplySummary | undefined {
  if (!message.ts || message.ts === input.threadTs) return undefined;
  if (message.subtype === 'bot_message') return undefined;
  if (message.bot_id) return undefined;
  if (message.user && input.ignoredUsers.has(message.user)) return undefined;

  const text = message.text?.trim();
  if (!text) return undefined;

  return {
    user: message.user,
    botId: message.bot_id,
    text,
    ts: message.ts,
  };
}

function normalizeNonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Slack askQuestion ${name} must be a non-negative number`);
  }
  return value;
}

function normalizePositive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Slack askQuestion ${name} must be a positive number`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
