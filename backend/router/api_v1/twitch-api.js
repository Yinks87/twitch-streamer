import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

import config from '../../config.js';
import * as db from '../../db/db.js';
import { requireAuth } from '../../middleware/index.js';
import {
  writeTranscript,
  readTranscript,
  transcriptNeedsCategory,
  TRANSCRIPTS_DIR,
} from '../../utils/transcript.js';
import { renameWithRetry } from '../../utils/fs-retry.js';
import { getStorageStatus } from '../../utils/media-storage.js';
import { downloadLimiter, mergeLimiter } from '../../utils/limiter.js';
import {
  probeStreams,
  getFormatIssues,
  normalizeVideoFile,
} from '../../utils/video-format.js';

const { VIDEOS_DIR, TWITCH_CLIENT_ID, YTDLP_PATH, FFMPEG_PATH } = config;
// yt-dlp writes here first so an in-progress/merging download never shows up as a
// (broken) video in the Mediathek, which lists VIDEOS_DIR directly.
export const DOWNLOADS_STAGING_DIR = path.join(
  path.resolve(VIDEOS_DIR),
  '.downloading',
);

function formatBytes(bytes) {
  const gib = Number(bytes) / 1024 ** 3;
  return `${Number.isFinite(gib) ? gib.toFixed(2) : '0.00'} GB`;
}

// Cleans up staged/partial files of a download (e.g. "<name>.mp4.part",
// "<name>.mp4.ytdl", "<name>.mp4.part-Frag123.part") after an abort or failure.
function removeDownloadArtifacts(
  filename,
  dirs = [DOWNLOADS_STAGING_DIR, VIDEOS_DIR],
) {
  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === filename || entry.startsWith(`${filename}.`)) {
          fs.rmSync(path.join(dir, entry), { force: true });
        }
      }
    } catch {}
  }
}

// yt-dlp's HLS output is raw MPEG-TS inside a .mp4 file, which browsers can't play;
// fragmented MP4s (moof boxes, no sidx) can't be probed without one range request per
// fragment, so long VODs never finish loading in the <video> preview.
function isMpegTs(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(189);
    const read = fs.readSync(fd, buf, 0, 189, 0);
    return read === 189 && buf[0] === 0x47 && buf[188] === 0x47;
  } finally {
    fs.closeSync(fd);
  }
}

function isFragmentedMp4(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 32 && pos + 8 <= size; i++) {
      fs.readSync(fd, header, 0, 16, pos);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moof') return true;
      if (type === 'mdat') return false;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) return false;
      if (boxSize < 8) return false;
      pos += boxSize;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Rewrites yt-dlp's raw output (MPEG-TS or fragmented MP4) as a regular MP4 with the
// index up front (stream copy, no re-encode). yt-dlp's own fixups are disabled so this
// is the single ffmpeg step per download, limited by the "max concurrent merges" setting.
async function makeSeekable(entryId, file) {
  if (!isMpegTs(file) && !isFragmentedMp4(file)) return;
  const dl = activeDownloads.get(entryId);
  if (dl) {
    dl.phase = 'waiting';
    dl.progress = 100;
    dl.speed = '';
    dl.eta = '';
  }
  const release = await mergeLimiter.acquire();
  try {
    if (!activeDownloads.has(entryId)) return; // aborted while waiting for a slot
    if (dl) dl.phase = 'processing';
    const tmp = `${file}.faststart.mp4`;
    console.log(`[ffmpeg] remuxing: ${file}`);
    await new Promise((resolve, reject) => {
      const ff = spawn(
        FFMPEG_PATH,
        [
          '-hide_banner',
          '-y',
          '-i',
          file,
          // Twitch HLS carries a timed-metadata data stream the MP4 muxer rejects.
          '-map',
          '0:v?',
          '-map',
          '0:a?',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          tmp,
        ],
        { stdio: 'ignore' },
      );
      if (dl) dl.process = ff; // so aborting the download also stops the remux
      ff.on('error', reject);
      ff.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg remux exit ${code}`)),
      );
    });
    fs.rmSync(file, { force: true });
    await renameWithRetry(tmp, file);
  } finally {
    release();
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

// Brings a video into the common streaming format (see utils/video-format.js).
// Runs behind the same "max concurrent merges" limit as the remux and shows up as the
// "processing" phase of the entry; aborting the entry kills the ffmpeg process. A failed
// conversion keeps the original file instead of losing the video. `options` are passed
// to normalizeVideoFile (stagingDir, beforeReplace).
export async function normalizeStagedFile(entryId, file, options = {}) {
  const streams = await probeStreams(file);
  if (getFormatIssues(streams).length === 0) return;
  const dl = activeDownloads.get(entryId);
  if (dl) {
    dl.phase = 'waiting';
    dl.progress = 100;
    dl.speed = '';
    dl.eta = '';
  }
  const release = await mergeLimiter.acquire();
  try {
    if (!activeDownloads.has(entryId)) return; // aborted while waiting for a slot
    if (dl) dl.phase = 'processing';
    const result = await normalizeVideoFile(file, {
      ...options,
      onProcess: (ff) => {
        if (dl) dl.process = ff;
      },
    });
    console.log(`[ffmpeg] converted ${file} (${result.issues.join(', ')})`);
  } catch (err) {
    if (!activeDownloads.has(entryId)) return; // aborted
    console.error(`[ffmpeg] format conversion failed: ${err.message}`);
    if (options.throwOnError) throw err;
  } finally {
    release();
  }
}

// Negative ids for background jobs that have no playlist entry (they share the
// activeDownloads registry, whose keys are playlist entry ids).
let nextPseudoJobId = -1;
export function nextJobId() {
  return nextPseudoJobId--;
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

const CLIP_PAGE_SIZE = 20;
const CLIP_SCAN_MAX_PAGES = 10;

// Query: sort ('views' = Twitch order | 'date'), creator, from/to (YYYY-MM-DD).
twitchApiRouter.get('/twitch/clips', requireAuth, async (req, res) => {
  try {
    const userId = await resolveBroadcasterId(req, req.query.user_login);
    if (!userId)
      return res.status(404).json({
        error: `Twitch-Nutzer "${req.query.user_login}" nicht gefunden.`,
      });

    const creator = String(req.query.creator || '')
      .trim()
      .toLowerCase();
    // Twitch can neither sort by date nor filter by creator, so those selections are
    // applied here over a bounded scan and paged with a numeric offset cursor.
    const needsScan = req.query.sort === 'date' || Boolean(creator);
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = dateRe.test(req.query.from) ? req.query.from : null;
    const to = dateRe.test(req.query.to) ? req.query.to : null;
    let cursor = needsScan ? undefined : req.query.after;
    let pagination = {};
    const clips = [];

    for (let page = 0; page < (needsScan ? CLIP_SCAN_MAX_PAGES : 1); page++) {
      const url = new URL('https://api.twitch.tv/helix/clips');
      url.searchParams.set('broadcaster_id', userId);
      url.searchParams.set('first', needsScan ? '100' : String(CLIP_PAGE_SIZE));
      // Twitch requires started_at whenever ended_at is used.
      if (from || to) {
        url.searchParams.set('started_at', `${from || '2016-01-01'}T00:00:00Z`);
        if (to) url.searchParams.set('ended_at', `${to}T23:59:59Z`);
      }
      if (cursor) url.searchParams.set('after', cursor);
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${req.user.access_token}`,
          'Client-Id': TWITCH_CLIENT_ID,
        },
      });
      const data = await r.json();

      if (!r.ok) throw new Error(data.message || 'Failed to fetch clips');
      clips.push(...(data.data || []));
      pagination = data.pagination || {};
      cursor = pagination.cursor;
      if (!cursor) break;
    }

    let pageClips = clips;
    if (needsScan) {
      const filtered = creator
        ? clips.filter((c) => c.creator_name?.toLowerCase().includes(creator))
        : clips;
      if (req.query.sort === 'date')
        filtered.sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at),
        );
      const offset = Number(req.query.after) || 0;
      pageClips = filtered.slice(offset, offset + CLIP_PAGE_SIZE);
      pagination =
        offset + CLIP_PAGE_SIZE < filtered.length
          ? { cursor: String(offset + CLIP_PAGE_SIZE) }
          : {};
    }
    const annotated = pageClips.map((clip) => {
      const entry = db.getPlaylistEntryByVodId(clip.id);
      return {
        ...clip,
        importStatus: entry ? entry.status : null,
        playlistId: entry ? entry.id : null,
      };
    });
    res.json({ data: annotated, pagination });
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

// Twitch's own creation date of a VOD/clip (ISO 8601). Looked up server-side so it doesn't
// depend on the client; the date sent by the client is only a fallback.
async function resolveTwitchCreatedAt(req, kind, remoteId) {
  try {
    const url = new URL(
      kind === 'clip'
        ? 'https://api.twitch.tv/helix/clips'
        : 'https://api.twitch.tv/helix/videos',
    );
    url.searchParams.set('id', remoteId);
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${req.user.access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    const data = await r.json();
    const createdAt = data?.data?.[0]?.created_at;
    if (r.ok && createdAt && !Number.isNaN(Date.parse(createdAt)))
      return new Date(createdAt).toISOString();
  } catch {}
  const fallback = req.body?.created_at;
  return typeof fallback === 'string' && !Number.isNaN(Date.parse(fallback))
    ? new Date(fallback).toISOString()
    : null;
}

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
    uploadedAt: new Date().toISOString(),
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

  const twitchCreatedAt = await resolveTwitchCreatedAt(req, kind, remoteId);

  let entry;
  if (existing) {
    db.updatePlaylistEntry(existing.id, {
      status: 'downloading',
      ...(twitchCreatedAt ? { twitch_created_at: twitchCreatedAt } : {}),
    });
    entry = {
      ...existing,
      status: 'downloading',
      twitch_created_at: twitchCreatedAt ?? existing.twitch_created_at,
    };
  } else {
    entry = db.addPlaylistEntry({
      source: kind,
      title,
      filename,
      vodId: remoteId,
      enabled: !transcriptNeedsCategory(meta),
      twitchCreatedAt,
    });
    db.updatePlaylistEntry(entry.id, { status: 'downloading' });
    entry.status = 'downloading';
  }

  writeTranscript(filename, meta);

  const entryId = entry.id;
  const ffmpegDir = path.dirname(FFMPEG_PATH);
  const ytdlpArgs = [
    '--no-playlist',
    '-N',
    '8',
    '-f',
    'bestvideo+bestaudio/best',
    '--merge-output-format',
    'mp4',
    // Remuxing is done by makeSeekable() so it can be limited to N parallel jobs.
    '--fixup',
    'never',
    ...(ffmpegDir !== '.' ? ['--ffmpeg-location', ffmpegDir] : []),
    '-o',
    stagingPath,
    sourceUrl,
  ];

  // Stays "queued" until one of the "max concurrent downloads" slots is free.
  activeDownloads.set(entryId, {
    process: null,
    progress: 0,
    speed: '',
    eta: '',
    phase: 'queued',
    filename,
    title,
  });

  const startDownload = (releaseSlot) => {
    console.log(`[yt-dlp] starting download: ${sourceUrl}`);
    const ytdlp = spawn(YTDLP_PATH, ytdlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const active = activeDownloads.get(entryId);
    active.process = ytdlp;
    active.phase = 'downloading';

    // yt-dlp uses \r for in-place progress lines on Windows — split on both \r and \n.
    const parseProgress = (chunk) => {
      for (const line of chunk
        .toString()
        .split(/[\r\n]+/)
        .filter(Boolean)) {
        // After the last fragment yt-dlp merges/remuxes/fixes the streams with ffmpeg
        // and prints no percentage, so surface it as a separate phase.
        if (/^\[(Merger|Fixup\w*|VideoRemuxer|VideoConvertor)\]/.test(line)) {
          const dl = activeDownloads.get(entryId);
          if (dl) {
            dl.phase = 'processing';
            dl.progress = 100;
            dl.speed = '';
            dl.eta = '';
          }
          continue;
        }
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
      releaseSlot();
      if (code === 0 && fs.existsSync(stagingPath)) {
        try {
          await makeSeekable(entryId, stagingPath);
          if (!activeDownloads.has(entryId)) return; // aborted while processing
          await normalizeStagedFile(entryId, stagingPath);
          if (!activeDownloads.has(entryId)) return; // aborted while converting
          activeDownloads.delete(entryId);
          await renameWithRetry(stagingPath, outPath);
        } catch (err) {
          if (!activeDownloads.has(entryId)) return;
          activeDownloads.delete(entryId);
          console.error(`[yt-dlp] failed to finalize download: ${err.message}`);
          db.updatePlaylistEntry(entryId, { status: 'error' });
          removeDownloadArtifacts(filename);
          return;
        }
        console.log(`[yt-dlp] ${kind} ${remoteId} downloaded successfully`);
        db.updatePlaylistEntry(entryId, { status: 'ready' });
      } else {
        activeDownloads.delete(entryId);
        console.error(
          `[yt-dlp] ${kind} ${remoteId} failed (exit code ${code})`,
        );
        db.updatePlaylistEntry(entryId, { status: 'error' });
        removeDownloadArtifacts(filename);
      }
    });

    ytdlp.on('error', (err) => {
      releaseSlot();
      activeDownloads.delete(entryId);
      console.error(`[yt-dlp] spawn error: ${err.message}`);
      db.updatePlaylistEntry(entryId, { status: 'error' });
      removeDownloadArtifacts(filename);
    });
  };

  downloadLimiter.acquire().then((releaseSlot) => {
    if (!activeDownloads.has(entryId)) return releaseSlot(); // aborted while queued
    startDownload(releaseSlot);
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
      phase: dl.phase,
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
    if (!dl.process) {
      // still queued, nothing running yet
    } else if (process.platform === 'win32' && dl.process.pid) {
      execSync(`taskkill /F /T /PID ${dl.process.pid}`, { stdio: 'ignore' });
    } else {
      dl.process.kill('SIGTERM');
    }
  } catch {}
  activeDownloads.delete(id);

  // Format conversions of an existing library video only own their staged output: the
  // video itself, its transcript and its playlist entry must survive a cancel.
  if (dl.kind === 'convert') {
    removeDownloadArtifacts(dl.filename, [DOWNLOADS_STAGING_DIR]);
    return res.json({ ok: true });
  }
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
