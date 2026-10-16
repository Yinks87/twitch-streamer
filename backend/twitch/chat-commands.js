import * as db from '../db/db.js';
import * as streamManager from '../streamManager.js';
import { sendChatMessage } from './api.js';
import { hasPermission } from './lib.js';
import { parseTemplate } from '../utils/template-parser.js';

const MAX_CHAT_LENGTH = 500;
const ECHO_WINDOW_MS = 15_000;

const lastUsedAt = new Map(); // command name -> timestamp of the last answer
const recentAnswers = new Map(); // answer text -> expiry, to ignore our own echo

// SQLite stores created_at as "YYYY-MM-DD HH:MM:SS" in UTC without a zone marker.
function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return '-';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Variables available in command responses (see the settings panel hint).
export function buildCommandVariables() {
  const info = streamManager.getCurrentVideoInfo();
  return {
    title: info?.title || '-',
    category: info?.category || '-',
    streamedat: formatDate(info?.twitchCreatedAt),
    uploadedat: formatDate(info?.createdAt),
  };
}

function rememberAnswer(text) {
  const now = Date.now();
  for (const [key, expiry] of recentAnswers) {
    if (expiry < now) recentAnswers.delete(key);
  }
  recentAnswers.set(text, now + ECHO_WINDOW_MS);
}

// Answers a "!command" chat message. Returns true when the message was a command
// (even if it was ignored because of permissions or cooldown) so no other handler
// processes it.
export async function handleChatCommand(event) {
  const text = String(event.message?.text ?? '').trim();
  if (!text.startsWith('!')) return false;

  const isOwnMessage = event.chatter_user_id === event.broadcaster_user_id;
  if (isOwnMessage && (recentAnswers.get(text) ?? 0) > Date.now()) return true;

  const name = text.slice(1).split(/\s+/)[0].toLowerCase();
  const command = name ? db.getChatCommandByName(name) : null;
  if (!command?.enabled) return false;

  if (!hasPermission({ event, requiredRole: command.requiredRole })) return true;

  const now = Date.now();
  if (now - (lastUsedAt.get(command.name) ?? 0) < command.cooldownSeconds * 1000)
    return true;
  lastUsedAt.set(command.name, now);

  const user = db.getBroadcasterUser();
  if (!user?.access_token) return true;

  const message = parseTemplate(command.response, buildCommandVariables())
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
  if (!message) return true;

  rememberAnswer(message);
  await sendChatMessage({
    access_token: user.access_token,
    broadcaster_id: user.twitch_user_id,
    sender_id: user.twitch_user_id,
    message,
  }).catch((err) =>
    console.error(`[chat-command] !${command.name} failed:`, err.message),
  );
  return true;
}
