import fs from 'node:fs';
import express from 'express';
import cors from 'cors';

import config from './config.js';
import * as db from './db/db.js';
import * as streamManager from './streamManager.js';
import { streamEvents } from './streamManager.js';
import baseRouter from './router/index.js';
import {
  applyChannelUpdate,
  pinChatMessage,
  sendChatMessage,
  startAccessTokenValidationLoop,
} from './twitch/api.js';
import { readTranscript, parseTimestamp } from './utils/transcript.js';
import { parseTemplate } from './utils/template-parser.js';
import { connectToTwitchEventSubs } from './twitch/event-subs/eventsubs.js';

const { PORT, VIDEOS_DIR, FRONTEND_URL } = config;

// A single failed request handler or Twitch API call must not take the server (and with
// it the supervision of the running stream) down.
process.on('unhandledRejection', (reason) => {
  console.error('[APP] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[APP] Uncaught exception:', err);
});

await db.openDatabase();

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

// Migrate existing video files into the playlist table on startup.
{
  const existing = streamManager.listVideoFiles();
  for (const filename of existing) {
    if (!db.getPlaylistEntryByFilename(filename)) {
      const t = readTranscript(filename);
      const title = t?.timestamps?.[0]?.title || t?.title || filename;
      db.addPlaylistEntry({
        source: 'upload',
        title,
        filename,
      });
    }
  }
  db.db
    .prepare(
      "UPDATE playlist SET status = 'error' WHERE status = 'downloading'",
    )
    .run();
  // No automatic re-encode queue exists anymore; recover any stale rows from
  // an older version so entries don't stay stuck as 'processing' forever.
  db.db
    .prepare("UPDATE playlist SET status = 'ready' WHERE status = 'processing'")
    .run();
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use('/', baseRouter);

// ── Dev fallback ─────────────────────────────────────────────────────────────
app.get(['/', '/app'], (req, res) => {
  if (FRONTEND_URL) return res.redirect(`${FRONTEND_URL}${req.path}`);
  res
    .status(200)
    .send(
      `<meta charset="utf-8"><p>Backend running on port ${PORT}. ` +
        `In Docker use <a href="http://localhost">:80</a>. ` +
        `In dev set <code>FRONTEND_URL=http://localhost:5173</code> and open ` +
        `<a href="http://localhost:5173">localhost:5173</a>.</p>`,
    );
});

app.listen(PORT, () => {
  console.log(`[APP] Twitch streamer backend listening on port ${PORT}`);
  startAccessTokenValidationLoop();
  connectToTwitchEventSubs();
  // Background check of all playlist videos: the format status is known (and cached)
  // before the first stream start or media library request.
  streamManager
    .checkPlaylistFormats()
    .catch((err) => console.error('[FORMAT-CHECK] failed:', err.message));
});

// ── Twitch channel auto-update on video change ────────────────────────────────

let pendingTimestampTimeouts = [];

function clearPendingTimestamps() {
  pendingTimestampTimeouts.forEach(clearTimeout);
  pendingTimestampTimeouts = [];
}

streamEvents.on('streamStopped', clearPendingTimestamps);

streamEvents.on('scheduledRestart', async ({ delaySeconds }) => {
  const settings = db.getSettings();
  const user = db.getBroadcasterUser();
  const message = settings?.chatMessages?.restartMessage;

  if (!user || !settings?.chatMessagesEnabled || !message) return;

  await sendChatMessage({
    access_token: user.access_token,
    broadcaster_id: user.twitch_user_id,
    sender_id: user.twitch_user_id,
    message: parseTemplate(message, { duration: delaySeconds }),
  })
    .then((res) => {
      console.log('restart message sent:', res);
    })
    .catch((err) =>
      console.error(
        '[scheduled-restart] chat notification error:',
        err.message,
      ),
    );
});

streamEvents.on('videoChanged', async (filename, context = {}) => {
  clearPendingTimestamps();

  const meta = readTranscript(filename);
  if (!meta) return;

  const timestamps =
    Array.isArray(meta.timestamps) && meta.timestamps.length > 0
      ? meta.timestamps
      : [{ time: '00:00:00', category: '', category_id: null, title: '' }];

  const user = db.getBroadcasterUser();
  let settings, chatMessagesEnabled, pinMessageEnabled, chatMessages;

  if (!user) return;

  const resumed = context.resumed === true;
  const resumeOffset = resumed ? Math.max(0, Number(context.offset) || 0) : 0;

  // A reconnect must keep the metadata already active on Twitch. The next
  // transcript marker after the saved offset will apply the next update.
  if (!resumed) {
    const first = timestamps[0];
    await applyChannelUpdate(
      user.access_token,
      first.title || '',
      first.category || '',
      first.category_id ?? null,
    )
      .then(async () => {
        settings = db.getSettings();
        chatMessagesEnabled = settings?.chatMessagesEnabled;
        pinMessageEnabled = settings?.pinMessageEnabled;
        chatMessages = settings?.chatMessages;

        if (chatMessagesEnabled) {
          await sendChatMessage({
            access_token: user.access_token,
            sender_id: user.twitch_user_id,
            broadcaster_id: user.twitch_user_id,
            message: parseTemplate(chatMessages.currentVideo, {
              title: first.title || '',
              category: first.category || '',
            }),
          });
        } else {
          console.log('[channel-update] chat messages are disabled.');
        }
      })
      .catch((err) => console.error('[channel-update] error:', err.message));
  }

  const pendingTimestamps = resumed ? timestamps : timestamps.slice(1);
  for (const ts of pendingTimestamps) {
    const secs = parseTimestamp(ts.time);
    const delaySecs = secs - resumeOffset;
    if (delaySecs <= 0) continue;
    const t = setTimeout(async () => {
      const freshUser = db.getBroadcasterUser();
      if (!freshUser) return;
      await applyChannelUpdate(
        freshUser.access_token,
        ts.title,
        ts.category,
        ts.category_id,
      )
        .then(async () => {
          // Refresh settings before sending chat message
          settings = db.getSettings();
          chatMessagesEnabled = settings?.chatMessagesEnabled;
          pinMessageEnabled = settings?.pinMessageEnabled;
          chatMessages = settings?.chatMessages;

          if (chatMessagesEnabled) {
            await sendChatMessage({
              access_token: freshUser.access_token,
              sender_id: freshUser.twitch_user_id,
              broadcaster_id: freshUser.twitch_user_id,
              message: parseTemplate(chatMessages.currentVideo, {
                title: ts.title || '',
                category: ts.category || '',
              }),
            });
          } else {
            console.log('[channel-update] chat messages are disabled.');
          }
        })
        .catch((err) =>
          console.error('[channel-update] timeout error:', err.message),
        );

      console.log('[channel-update] completed for timestamp:', ts.time);
    }, delaySecs * 1000);
    pendingTimestampTimeouts.push(t);
  }
});
