import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

import config from '../../config.js';
import * as db from '../../db/db.js';
import { requireAuth } from '../../middleware/index.js';
import { writeTranscript, readTranscript, transcriptNeedsCategory, TRANSCRIPTS_DIR } from '../../utils/transcript.js';
import { renameWithRetry } from '../../utils/fs-retry.js';
import {
  getStorageStatus,
} from '../../utils/media-storage.js';

const { VIDEOS_DIR, TWITCH_CLIENT_ID, YTDLP_PATH, FFMPEG_PATH } = config;
// yt-dlp writes here first so an in-progress/merging download never shows up as a
// (broken) video in the Mediathek, which lists VIDEOS_DIR directly.
const DOWNLOADS_STAGING_DIR = path.join(path.resolve(VIDEOS_DIR), '.downloading');

function formatBytes(bytes) {
  const gib = Number(bytes) / 1024 ** 3;
  return `${Number.isFinite(gib) ? gib.toFixed(2) : '0.00'} GB`;
}

// Removes any leftover staged/partial files for a download (e.g. "<name>.mp4.part",
// "<name>.mp4.ytdl", "<name>.mp4.part-Frag123.part") after an abort or failure.
function removeDownloadArtifacts(filename) {
  for (const dir of [DOWNLOADS_STAGING_DIR, VIDEOS_DIR]) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === filename || entry.startsWith(`${filename}.`)) {
          fs.rmSync(path.join(dir, entry), { force: true });
        }
      }
    } catch {}
  }
}

// Resolves a login name to a Twitch user ID, or falls back to the signed-in user.
// Returns null if an explicitly requested login name couldn't be found.
async function resolveBroadcasterId(req, userLogin) {
  if (!userLogin) return req.user.twitch_user_id;
  const uRes = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(userLogin)}`,
    {
      headers: {
        Authorization: `Bearer ${req.user.access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    },
  );
  const uData = await uRes.json();
  if (!uRes.ok || !uData.data?.[0]) return null;
  return uData.data[0].id;
}

// entryId → { process, progress, speed, eta, filename, title }
export const activeDownloads = new Map();

const twitchApiRouter = express.Router();

twitchApiRouter.get('/twitch/vods', requireAuth, async (req, res) => {
  try {
    const userId = await resolveBroadcasterId(req, req.query.user_login);
    if (!userId)
      return res.status(404).json({
        error: `Twitch-Nutzer "${req.query.user_login}" nicht gefunden.`,
      });

    const url = new URL('https://api.twitch.tv/helix/videos');
    url.searchParams.set('user_id', userId);
    url.searchParams.set('type', 'archive');
    url.searchParams.set('first', '20');
    if (req.query.after) url.searchParams.set('after', req.query.after);
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${req.user.access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Failed to fetch VODs');
    const annotated = (data.data || []).map((vod) => {
      const entry = db.getPlaylistEntryByVodId(vod.id);
      return {
        ...vod,
        importStatus: entry ? entry.status : null,
        playlistId: entry ? entry.id : null,
      };
    });
    res.json({ data: annotated, pagination: data.pagination });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Twitch's Get Clips endpoint only sorts by view count server-side — the frontend
// re-sorts the loaded page by date/views and filters by creator name itself.
twitchApiRouter.get('/twitch/clips', requireAuth, async (req, res) => {
  try {
    const userId = await resolveBroadcasterId(req, req.query.user_login);
    if (!userId)
      return res.status(404).json({
        error: `Twitch-Nutzer "${req.query.user_login}" nicht gefunden.`,
      });

    const url = new URL('https://api.twitch.tv/helix/clips');
    url.searchParams.set('broadcaster_id', userId);
    url.searchParams.set('first', '20');
    if (req.query.after) url.searchParams.set('after', req.query.after);
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${req.user.access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Failed to fetch clips');
    const annotated = (data.data || []).map((clip) => {
      const entry = db.getPlaylistEntryByVodId(clip.id);
      return {
        ...clip,
        importStatus: entry ? entry.status : null,
        playlistId: entry ? entry.id : null,
      };
    });
    res.json({ data: annotated, pagination: data.pagination });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

twitchApiRouter.get('/twitch/categories', requireAuth, async (req, res) => {
  const query = (req.query.query || '').trim();
  if (!query) return res.json({ data: [] });
  try {
    const url = new URL('https://api.twitch.tv/helix/search/categories');
    url.searchParams.set('query', query);
    url.searchParams.set('first', '8');
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${req.user.access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    const data = await r.json();
    res.json(r.ok ? data : { data: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared by VOD and clip imports: downloads `sourceUrl` via yt-dlp into a staging
// directory, tracks progress, and moves the finished file into VIDEOS_DIR on success.
async function importRemoteVideo(
  req,
  res,
  { kind, remoteId, sourceUrl, defaultTitle, withMutedSegments },
) {
  const title = (req.body?.title || defaultTitle).trim();
  const categoryId = req.body?.category_id ?? null;

  const existing = db.getPlaylistEntryByVodId(remoteId);
  if (existing && existing.status === 'ready') {
    return res.json({ entry: existing, alreadyImported: true });
  }

  const storageStatus = getStorageStatus();
  if (storageStatus.usedBytes >= storageStatus.limitBytes)
    return res.status(413).json({
      error: `Speicherlimit erreicht: ${formatBytes(storageStatus.usedBytes)} von ${formatBytes(storageStatus.limitBytes)} belegt. Weitere Uploads und Downloads sind gesperrt.`,
    });

  try {
    await new Promise((resolve, reject) => {
      const check = spawn(YTDLP_PATH, ['--version'], { stdio: 'ignore' });
      check.on('error', reject);
      check.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
    });
  } catch (err) {
    return res.status(503).json({
      error: `yt-dlp not found ("${YTDLP_PATH}"): ${err.message}. Install it from https://github.com/yt-dlp/yt-dlp#installation or set YTDLP_PATH in .env.`,
    });
  }

  const filename = `${crypto.randomUUID()}.mp4`;
  const outPath = path.join(VIDEOS_DIR, filename);
  fs.mkdirSync(DOWNLOADS_STAGING_DIR, { recursive: true });
  const stagingPath = path.join(DOWNLOADS_STAGING_DIR, filename);

  // Twitch reports muted (copyright-flagged) stretches as {offset, duration} in seconds
  // on VODs only; stored now since the VOD (and this data) may expire later.
  const mutedSegments =
    withMutedSegments && Array.isArray(req.body?.muted_segments)
      ? req.body.muted_segments
          .filter(
            (s) => Number.isFinite(s?.offset) && Number.isFinite(s?.duration),
          )
          .map((s) => ({ offset: s.offset, duration: s.duration }))
      : undefined;

  const meta = {
    source: kind,
    vodId: remoteId,
    ...(mutedSegments ? { mutedSegments } : {}),
    timestamps: [
      {
        time: '00:00:00',
        category: req.body?.category || '',
        category_id: categoryId ?? null,
        title,
      },
    ],
  };

  let entry;
  if (existing) {
    db.updatePlaylistEntry(existing.id, { status: 'downloading' });
    entry = { ...existing, status: 'downloading' };
  } else {
    entry = db.addPlaylistEntry({
      source: kind,
      title,
      filename,
      vodId: remoteId,
      enabled: !transcriptNeedsCategory(meta),
    });
    db.updatePlaylistEntry(entry.id, { status: 'downloading' });
    entry.status = 'downloading';
  }

  writeTranscript(filename, meta);

  const entryId = entry.id;
  const ffmpegDir = path.dirname(FFMPEG_PATH);
  const ytdlpArgs = [
    '--no-playlist',
    '-f',
    'bestvideo+bestaudio/best',
    '--merge-output-format',
    'mp4',
    ...(ffmpegDir !== '.' ? ['--ffmpeg-location', ffmpegDir] : []),
    '-o',
    stagingPath,
    sourceUrl,
  ];

  console.log(`[yt-dlp] starting download: ${sourceUrl}`);
  const ytdlp = spawn(YTDLP_PATH, ytdlpArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeDownloads.set(entryId, {
    process: ytdlp,
    progress: 0,
    speed: '',
    eta: '',
    filename,
    title,
  });

  // yt-dlp uses \r for in-place progress lines on Windows — split on both \r and \n.
  const parseProgress = (chunk) => {
    for (const line of chunk
      .toString()
      .split(/[\r\n]+/)
      .filter(Boolean)) {
      const m = line.match(
        /\[download\]\s+([\d.]+)%.*?at\s+(\S+)\s+ETA\s+(\S+)/,
      );
      if (m) {
        const dl = activeDownloads.get(entryId);
        if (dl) {
          dl.progress = parseFloat(m[1]);
          dl.speed = m[2];
          dl.eta = m[3];
        }
      }
    }
  };

  ytdlp.stdout.on('data', (c) => {
    c.toString()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .forEach((l) => console.log('[yt-dlp]', l));
    parseProgress(c);
  });
  ytdlp.stderr.on('data', (c) => {
    c.toString()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .forEach((l) => console.error('[yt-dlp]', l));
    parseProgress(c);
  });

  ytdlp.on('exit', async (code) => {
    activeDownloads.delete(entryId);
    if (code === 0 && fs.existsSync(stagingPath)) {
      try {
        await renameWithRetry(stagingPath, outPath);
      } catch (err) {
        console.error(`[yt-dlp] failed to move finished download: ${err.message}`);
        db.updatePlaylistEntry(entryId, { status: 'error' });
        removeDownloadArtifacts(filename);
        return;
      }
      console.log(`[yt-dlp] ${kind} ${remoteId} downloaded successfully`);
      db.updatePlaylistEntry(entryId, { status: 'ready' });
    } else {
      console.error(`[yt-dlp] ${kind} ${remoteId} failed (exit code ${code})`);
      db.updatePlaylistEntry(entryId, { status: 'error' });
      removeDownloadArtifacts(filename);
    }
  });

  ytdlp.on('error', (err) => {
    activeDownloads.delete(entryId);
    console.error(`[yt-dlp] spawn error: ${err.message}`);
    db.updatePlaylistEntry(entryId, { status: 'error' });
    removeDownloadArtifacts(filename);
  });

  res.json({ entry });
}

twitchApiRouter.post(
  '/twitch/vods/:id/import',
  requireAuth,
  async (req, res) => {
    const vodId = req.params.id;
    await importRemoteVideo(req, res, {
      kind: 'vod',
      remoteId: vodId,
      sourceUrl: `https://www.twitch.tv/videos/${vodId}`,
      defaultTitle: `VOD ${vodId}`,
      withMutedSegments: true,
    });
  },
);

twitchApiRouter.post(
  '/twitch/clips/:id/import',
  requireAuth,
  async (req, res) => {
    const clipId = req.params.id;
    await importRemoteVideo(req, res, {
      kind: 'clip',
      remoteId: clipId,
      sourceUrl: `https://clips.twitch.tv/${clipId}`,
      defaultTitle: `Clip ${clipId}`,
      withMutedSegments: false,
    });
  },
);

twitchApiRouter.get('/downloads', requireAuth, (req, res) => {
  const list = [];
  for (const [entryId, dl] of activeDownloads) {
    list.push({
      entryId,
      filename: dl.filename,
      title: dl.title,
      progress: dl.progress,
      speed: dl.speed,
      eta: dl.eta,
      transcript: readTranscript(dl.filename),
    });
  }
  res.json({ downloads: list });
});

twitchApiRouter.delete('/downloads/:entryId', requireAuth, (req, res) => {
  const id = Number(req.params.entryId);
  const dl = activeDownloads.get(id);
  if (!dl) return res.status(404).json({ error: 'Download not found' });
  // Use taskkill /T on Windows to kill the whole process tree (yt-dlp + ffmpeg child).
  try {
    if (process.platform === 'win32' && dl.process.pid) {
      execSync(`taskkill /F /T /PID ${dl.process.pid}`, { stdio: 'ignore' });
    } else {
      dl.process.kill('SIGTERM');
    }
  } catch {}
  activeDownloads.delete(id);

  // Clean up the finished file, any yt-dlp partial/fragment/resume files left behind,
  // and the transcript so an aborted download doesn't leave orphaned data behind.
  removeDownloadArtifacts(dl.filename);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${dl.filename}.json`);
  try {
    if (fs.existsSync(transcriptPath)) fs.unlinkSync(transcriptPath);
  } catch {}

  db.removePlaylistEntry(id);
  res.json({ ok: true });
});

export default twitchApiRouter;
