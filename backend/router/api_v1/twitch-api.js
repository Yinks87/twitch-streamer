import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

import config from '../../config.js';
import * as db from '../../db/db.js';
import { requireAuth } from '../../middleware/index.js';
import { writeTranscript, readTranscript, transcriptNeedsCategory, TRANSCRIPTS_DIR } from '../../utils/transcript.js';

const { VIDEOS_DIR, TWITCH_CLIENT_ID, YTDLP_PATH, FFMPEG_PATH } = config;

// entryId → { process, progress, speed, eta, filename, title }
export const activeDownloads = new Map();

const twitchApiRouter = express.Router();

twitchApiRouter.get('/twitch/vods', requireAuth, async (req, res) => {
  try {
    let userId = req.user.twitch_user_id;
    if (req.query.user_login) {
      const uRes = await fetch(
        `https://api.twitch.tv/helix/users?login=${encodeURIComponent(req.query.user_login)}`,
        {
          headers: {
            Authorization: `Bearer ${req.user.access_token}`,
            'Client-Id': TWITCH_CLIENT_ID,
          },
        },
      );
      const uData = await uRes.json();
      if (!uRes.ok || !uData.data?.[0])
        return res.status(404).json({
          error: `Twitch-Nutzer "${req.query.user_login}" nicht gefunden.`,
        });
      userId = uData.data[0].id;
    }
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

twitchApiRouter.post(
  '/twitch/vods/:id/import',
  requireAuth,
  async (req, res) => {
    const vodId = req.params.id;
    const title = (req.body?.title || `VOD ${vodId}`).trim();
    const categoryId = req.body?.category_id ?? null;
    console.log(req.body);

    const existing = db.getPlaylistEntryByVodId(vodId);
    if (existing && existing.status === 'ready') {
      return res.json({ entry: existing, alreadyImported: true });
    }

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
    const meta = {
      source: 'vod',
      vodId,
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
        source: 'vod',
        title,
        filename,
        vodId,
        enabled: !transcriptNeedsCategory(meta),
      });
      db.updatePlaylistEntry(entry.id, { status: 'downloading' });
      entry.status = 'downloading';
    }

    writeTranscript(filename, meta);

    const entryId = entry.id;
    const vodUrl = `https://www.twitch.tv/videos/${vodId}`;
    const ffmpegDir = path.dirname(FFMPEG_PATH);
    const ytdlpArgs = [
      '--no-playlist',
      '-f',
      'bestvideo+bestaudio/best',
      '--merge-output-format',
      'mp4',
      ...(ffmpegDir !== '.' ? ['--ffmpeg-location', ffmpegDir] : []),
      '-o',
      outPath,
      vodUrl,
    ];

    console.log(`[yt-dlp] starting download: ${vodUrl}`);
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

    ytdlp.on('exit', (code) => {
      activeDownloads.delete(entryId);
      if (code === 0 && fs.existsSync(outPath)) {
        console.log(`[yt-dlp] VOD ${vodId} downloaded successfully`);
        db.updatePlaylistEntry(entryId, { status: 'ready' });
      } else {
        console.error(`[yt-dlp] VOD ${vodId} failed (exit code ${code})`);
        db.updatePlaylistEntry(entryId, { status: 'error' });
      }
    });

    ytdlp.on('error', (err) => {
      activeDownloads.delete(entryId);
      console.error(`[yt-dlp] spawn error: ${err.message}`);
      db.updatePlaylistEntry(entryId, { status: 'error' });
    });

    res.json({ entry });
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

  // Clean up the finished file, any yt-dlp partial/fragment/resume files left behind
  // (e.g. "<name>.mp4.part", "<name>.mp4.ytdl", "<name>.mp4.part-Frag123.part"), and the
  // transcript so an aborted download doesn't leave orphaned data behind.
  try {
    for (const entry of fs.readdirSync(VIDEOS_DIR)) {
      if (entry === dl.filename || entry.startsWith(`${dl.filename}.`)) {
        fs.rmSync(path.join(VIDEOS_DIR, entry), { force: true });
      }
    }
  } catch {}
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${dl.filename}.json`);
  try {
    if (fs.existsSync(transcriptPath)) fs.unlinkSync(transcriptPath);
  } catch {}

  db.removePlaylistEntry(id);
  res.json({ ok: true });
});

export default twitchApiRouter;
