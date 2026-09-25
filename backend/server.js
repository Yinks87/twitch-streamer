import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';

import config from './config.js';
import * as db from './db.js';
import * as streamManager from './streamManager.js';
import { streamEvents } from './streamManager.js';
import baseRouter from './router/index.js';
import { applyChannelUpdate, startAccessTokenValidationLoop } from './twitch/api.js';
import { readTranscript } from './utils/transcript.js';

const {
  PORT,
  VIDEOS_DIR,
  FRONTEND_URL,
} = config;

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
    .prepare(
      "UPDATE playlist SET status = 'ready' WHERE status = 'processing'",
    )
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
  console.log(`Twitch streamer backend listening on port ${PORT}`);
  console.log(`Videos folder: ${VIDEOS_DIR}`);
  startAccessTokenValidationLoop();
});

// ── Twitch channel auto-update on video change ────────────────────────────────

function parseTimestamp(t) {
  if (!t) return 0;
  const parts = String(t).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t) || 0;
}

let pendingTimestampTimeouts = [];

function clearPendingTimestamps() {
  pendingTimestampTimeouts.forEach(clearTimeout);
  pendingTimestampTimeouts = [];
}

streamEvents.on('streamStopped', clearPendingTimestamps);

streamEvents.on('videoChanged', (filename) => {
  clearPendingTimestamps();

  const meta = readTranscript(filename);
  if (!meta) return;

  const timestamps = Array.isArray(meta.timestamps) && meta.timestamps.length > 0
    ? meta.timestamps
    : [{ time: '00:00:00', category: '', category_id: null, title: '' }];

  // Channel updates must use the broadcaster's own token — using any logged-in user
  // (e.g. a manager) fails or silently updates the wrong channel.
  const user = db.getBroadcasterUser();
  if (!user) return;

  const first = timestamps[0];
  applyChannelUpdate(
    user.access_token,
    first.title || '',
    first.category || '',
    first.category_id ?? null,
  ).catch((err) => console.error('[channel-update] error:', err.message));

  for (const ts of timestamps.slice(1)) {
    const secs = parseTimestamp(ts.time);
    if (secs <= 0) continue;
    const t = setTimeout(() => {
      const freshUser = db.getBroadcasterUser();
      if (!freshUser) return;
      applyChannelUpdate(
        freshUser.access_token,
        ts.title,
        ts.category,
        ts.category_id,
      ).catch((err) => console.error('[channel-update] timeout error:', err.message));
    }, secs * 1000);
    pendingTimestampTimeouts.push(t);
  }
});
