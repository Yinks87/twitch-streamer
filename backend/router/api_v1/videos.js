import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import multer from 'multer';

import config from '../../config.js';
import * as db from '../../db/db.js';
import * as streamManager from '../../streamManager.js';
import { requireAuth } from '../../middleware/index.js';
import {
  readTranscript,
  writeTranscript,
  TRANSCRIPTS_DIR,
  transcriptNeedsCategory,
} from '../../utils/transcript.js';
import { renameWithRetry } from '../../utils/fs-retry.js';
import { getStorageStatus } from '../../utils/media-storage.js';

const { VIDEOS_DIR, FFMPEG_PATH } = config;
const THUMBS_DIR = path.join(path.resolve(VIDEOS_DIR), '.thumbs');
// ffmpeg writes the trimmed output here first so the in-progress re-encode never
// shows up as a (broken) video in the Mediathek, which lists VIDEOS_DIR directly.
const TRIM_STAGING_DIR = path.join(path.resolve(VIDEOS_DIR), '.trimming');
const UPLOAD_STAGING_DIR = path.join(path.resolve(VIDEOS_DIR), '.uploading');
// ffprobe lives next to ffmpeg, mirrors streamManager.js
const FFPROBE_PATH = FFMPEG_PATH.replace(
  /ffmpeg(\.exe)?$/i,
  (_, ext) => `ffprobe${ext ?? ''}`,
);
const generatingThumbs = new Set();
// filename → percent (0-100) while a trim is re-encoding; absent once finished.
const trimProgress = new Map();
// Serializes trims: each job chains onto this promise.
let trimQueueTail = Promise.resolve();
// Filenames with a trim queued or running / only those still waiting for their turn.
const trimsActive = new Set();
const trimsWaiting = new Set();
// filename → Set of open read streams serving /stream requests, so a trim can
// force-close stale handles that would otherwise keep Windows from renaming over the file.
const activeStreamReaders = new Map();

function formatBytes(bytes) {
  const gib = Number(bytes) / 1024 ** 3;
  return `${Number.isFinite(gib) ? gib.toFixed(2) : '0.00'} GB`;
}

function trackStreamReader(name, stream) {
  if (!activeStreamReaders.has(name)) activeStreamReaders.set(name, new Set());
  const readers = activeStreamReaders.get(name);
  readers.add(stream);
  const untrack = () => {
    readers.delete(stream);
    if (readers.size === 0) activeStreamReaders.delete(name);
  };
  stream.once('close', untrack);
  stream.once('error', untrack);
}

// pipe() does not destroy the source when the client aborts. Browsers cancel many
// range requests while probing large videos, so unclosed read streams would leak
// file handles until the server stops answering.
function pipeVideoStream(name, stream, res) {
  trackStreamReader(name, stream);
  res.on('close', () => stream.destroy());
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);
}

function closeActiveStreamReaders(name) {
  const readers = activeStreamReaders.get(name);
  if (!readers) return;
  for (const stream of readers) {
    try {
      stream.destroy();
    } catch {}
  }
  activeStreamReaders.delete(name);
}

const ALLOWED_EXT = new Set([
  '.mp4',
  '.mkv',
  '.mov',
  '.flv',
  '.ts',
  '.webm',
  '.avi',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
    cb(null, UPLOAD_STAGING_DIR);
  },
  // UUID filename so no metadata is encoded in the filename.
  filename: (req, file, cb) => {
    cb(null, `${crypto.randomUUID()}.mp4`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext))
      return cb(new Error(`Unsupported file type: ${ext}`));
    cb(null, true);
  },
});

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        filePath,
      ],
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout);
          const dur = parseFloat(data?.format?.duration);
          if (!Number.isFinite(dur))
            return reject(
              new Error('Videolänge konnte nicht ermittelt werden.'),
            );
          resolve(dur);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

// Sorts and merges overlapping/adjacent [start,end] ranges (seconds).
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

// Maps a timestamp from the original timeline onto the trimmed timeline by subtracting
// the cumulative duration of every removed range before it (clamping times that fall
// inside a removed range to the point where the cut begins).
function mapTime(t, removedRanges) {
  let shift = 0;
  for (const r of removedRanges) {
    if (t < r.start) break;
    if (t <= r.end) return Math.max(0, r.start - shift);
    shift += r.end - r.start;
  }
  return Math.max(0, t - shift);
}

function timestampToSeconds(time) {
  const [h, m, s] = (time || '00:00:00').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function secondsToTimestamp(totalSeconds) {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const videosRouter = express.Router();

videosRouter.get('/videos', (req, res) => {
  const files = streamManager.listVideoFiles().map((name) => {
    const stat = fs.statSync(path.join(VIDEOS_DIR, name));
    return {
      name,
      size: stat.size,
      modifiedAt: stat.mtime,
      transcript: readTranscript(name),
    };
  });
  res.json({ videos: files, storage: getStorageStatus() });
});

videosRouter.post('/storage/check', requireAuth, (req, res) => {
  const status = getStorageStatus();
  const uploadBytes = Number(req.body?.bytes ?? 0);
  if (!Number.isFinite(uploadBytes) || uploadBytes < 0)
    return res.status(400).json({ error: 'Ungültige Uploadgröße.' });
  if (
    status.usedBytes >= status.limitBytes ||
    status.usedBytes + uploadBytes > status.limitBytes
  )
    return res.status(413).json({
      error: `Upload nicht möglich: ${formatBytes(status.usedBytes)} belegt, ${formatBytes(uploadBytes)} zusätzlich benötigt, Limit ${formatBytes(status.limitBytes)}.`,
    });
  res.json({ storage: status });
});

videosRouter.post(
  '/upload',
  (req, res, next) => {
    const status = getStorageStatus();
    if (status.usedBytes >= status.limitBytes) {
      return res.status(413).json({
        error: `Speicherlimit erreicht: ${formatBytes(status.usedBytes)} von ${formatBytes(status.limitBytes)} belegt. Weitere Uploads und Downloads sind gesperrt.`,
      });
    }
    next();
  },
  upload.array('videos', 50),
  (req, res) => {
    const status = getStorageStatus();
    if (status.usedBytes > status.limitBytes) {
      for (const file of req.files || []) fs.rmSync(file.path, { force: true });
      return res.status(413).json({
        error: `Upload verworfen: Speicherbedarf ${formatBytes(status.usedBytes)} überschreitet das Limit von ${formatBytes(status.limitBytes)}.`,
      });
    }
    for (const file of req.files || []) {
      const destination = path.join(VIDEOS_DIR, file.filename);
      fs.renameSync(file.path, destination);
      file.path = destination;
    }
    let metaList = [];
    try {
      metaList = JSON.parse(req.body.meta || '[]');
    } catch {}

    const saved = (req.files || []).map((f, i) => {
      const m = metaList[i] || {};
      const firstTimestamp = {
        time: '00:00:00',
        category: m.category || '',
        category_id: m.category_id ?? null,
        title: m.title || f.originalname.replace(/\.[^.]+$/, ''),
      };
      const timestamps =
        Array.isArray(m.timestamps) && m.timestamps.length > 0
          ? m.timestamps.map((ts) => ({
              time: ts.time || '00:00:00',
              category: ts.category || '',
              category_id: ts.category_id ?? null,
              title: ts.title || '',
            }))
          : [firstTimestamp];
      const meta = {
        originalName: f.originalname,
        source: 'upload',
        timestamps,
      };
      if (!timestamps[0]) timestamps[0] = firstTimestamp;
      timestamps[0].time = timestamps[0].time || '00:00:00';
      timestamps[0].category =
        timestamps[0].category || firstTimestamp.category;
      timestamps[0].category_id =
        timestamps[0].category_id ?? firstTimestamp.category_id;
      timestamps[0].title = timestamps[0].title || firstTimestamp.title;
      writeTranscript(f.filename, meta);
      const entryTitle =
        timestamps[0]?.title || f.originalname.replace(/\.[^.]+$/, '');
      if (
        m.addToPlaylist !== false &&
        !db.getPlaylistEntryByFilename(f.filename)
      ) {
        db.addPlaylistEntry({
          source: 'upload',
          title: entryTitle,
          filename: f.filename,
          enabled: !transcriptNeedsCategory(meta),
        });
      }
      return { name: f.filename, size: f.size, meta };
    });
    res.json({ uploaded: saved });
  },
);

videosRouter.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

videosRouter.put('/videos/:name/transcript', (req, res) => {
  const name = path.basename(req.params.name);
  if (!fs.existsSync(path.join(VIDEOS_DIR, name)))
    return res.status(404).json({ error: 'File not found' });

  const existing = readTranscript(name) || {
    timestamps: [
      { time: '00:00:00', category: '', category_id: null, title: '' },
    ],
  };
  const timestamps =
    Array.isArray(req.body?.timestamps) && req.body.timestamps.length > 0
      ? req.body.timestamps.map((ts) => ({
          time: ts.time || '00:00:00',
          category: ts.category || '',
          category_id: ts.category_id ?? null,
          title: ts.title || '',
        }))
      : Array.isArray(existing.timestamps) && existing.timestamps.length > 0
        ? existing.timestamps.map((ts) => ({
            time: ts.time || '00:00:00',
            category: ts.category || '',
            category_id: ts.category_id ?? null,
            title: ts.title || '',
          }))
        : [{ time: '00:00:00', category: '', category_id: null, title: '' }];

  const first = timestamps[0] || {
    time: '00:00:00',
    category: '',
    category_id: null,
    title: '',
  };
  first.time = first.time || '00:00:00';
  first.title = req.body?.title ?? first.title ?? '';
  first.category = req.body?.category ?? first.category ?? '';
  first.category_id = req.body?.category_id ?? first.category_id ?? null;

  const updated = { ...existing, timestamps };
  writeTranscript(name, updated);

  const entry = db.getPlaylistEntryByFilename(name);
  if (entry) {
    const fields = { enabled: transcriptNeedsCategory(updated) ? 0 : 1 };
    if (first.title) fields.title = first.title;
    db.updatePlaylistEntry(entry.id, fields);
  }
  res.json({ transcript: updated });
});

// Cuts the given ranges (seconds, absolute to the current file) out of a video with
// ffmpeg, re-encodes the remaining parts together, and replaces the original file —
// the destructive confirmation happens client-side before this is ever called.
// Only one re-encode runs at a time so the machine isn't overloaded; further requests
// wait in a queue and start as soon as the previous one has finished.
videosRouter.post('/videos/:name/trim', async (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(VIDEOS_DIR, name);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found' });

  // The queued segments refer to the current timeline, so a second cut of the same
  // file must wait until the first one has replaced it.
  if (trimsActive.has(name))
    return res.status(409).json({
      error: 'Für dieses Video läuft oder wartet bereits ein Schnitt.',
    });

  trimsActive.add(name);
  trimsWaiting.add(name);
  const job = trimQueueTail.then(() => {
    trimsWaiting.delete(name);
    return runTrim(name, filePath, req, res);
  });
  trimQueueTail = job.catch(() => {});
  try {
    await job;
  } catch (err) {
    if (!res.headersSent)
      res.status(500).json({ error: `Schnitt fehlgeschlagen: ${err.message}` });
  } finally {
    trimsWaiting.delete(name);
    trimsActive.delete(name);
  }
});

async function runTrim(name, filePath, req, res) {
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found' });

  const rawSegments = Array.isArray(req.body?.segments)
    ? req.body.segments
    : [];
  const segments = rawSegments
    .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    );

  if (segments.length === 0)
    return res
      .status(400)
      .json({ error: 'Keine gültigen Schnittbereiche angegeben.' });

  let duration;
  try {
    duration = await probeDuration(filePath);
  } catch (err) {
    return res
      .status(500)
      .json({
        error: `Videolänge konnte nicht ermittelt werden: ${err.message}`,
      });
  }

  const removed = mergeRanges(
    segments.map((s) => ({
      start: Math.max(0, Math.min(s.start, duration)),
      end: Math.max(0, Math.min(s.end, duration)),
    })),
  ).filter((r) => r.end > r.start);

  if (removed.length === 0)
    return res
      .status(400)
      .json({ error: 'Keine gültigen Schnittbereiche angegeben.' });

  const keep = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start > cursor) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });

  // Sub-second segments can yield ~0 encoded frames, which breaks the concat filter.
  const MIN_KEEP_SECONDS = 0.5;
  const significantKeep = keep.filter(
    (k) => k.end - k.start >= MIN_KEEP_SECONDS,
  );

  if (significantKeep.length === 0)
    return res
      .status(400)
      .json({ error: 'Der Schnitt würde das gesamte Video entfernen.' });

  const totalKeptDuration = significantKeep.reduce(
    (sum, k) => sum + (k.end - k.start),
    0,
  );
  fs.mkdirSync(TRIM_STAGING_DIR, { recursive: true });
  const tempPath = path.join(TRIM_STAGING_DIR, `${crypto.randomUUID()}.mp4`);
  const filterParts = [];
  const concatInputs = [];
  significantKeep.forEach((k, i) => {
    filterParts.push(
      `[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`,
    );
    concatInputs.push(`[v${i}][a${i}]`);
  });
  filterParts.push(
    `${concatInputs.join('')}concat=n=${significantKeep.length}:v=1:a=1[outv][outa]`,
  );

  const ffmpegArgs = [
    '-y',
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    filePath,
    '-filter_complex',
    filterParts.join('; '),
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    tempPath,
  ];

  trimProgress.set(name, 0);
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn(FFMPEG_PATH, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      ff.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m && totalKeptDuration > 0) {
            const seconds =
              Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
            trimProgress.set(
              name,
              Math.min(99, (seconds / totalKeptDuration) * 100),
            );
          }
        }
      });
      ff.stderr.on('data', (c) => {
        stderr += c.toString();
      });
      ff.on('error', reject);
      ff.on('exit', (code) => {
        if (code === 0) resolve();
        else
          reject(new Error(`ffmpeg exit code ${code}: ${stderr.slice(-2000)}`));
      });
    });
  } catch (err) {
    trimProgress.delete(name);
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    return res
      .status(500)
      .json({ error: `Schnitt fehlgeschlagen: ${err.message}` });
  }
  trimProgress.set(name, 100);

  const existing = readTranscript(name) || {
    timestamps: [
      { time: '00:00:00', category: '', category_id: null, title: '' },
    ],
  };
  const timestamps = (existing.timestamps || []).map((ts) => ({
    ...ts,
    time: secondsToTimestamp(mapTime(timestampToSeconds(ts.time), removed)),
  }));
  const remainingMuted = (existing.mutedSegments || [])
    .map((seg) => {
      const segStart = seg.offset;
      const segEnd = seg.offset + seg.duration;
      const fullyCut = removed.some(
        (r) => r.start <= segStart && segEnd <= r.end,
      );
      if (fullyCut) return null;
      const newStart = mapTime(segStart, removed);
      const newEnd = mapTime(segEnd, removed);
      return newEnd > newStart
        ? { offset: newStart, duration: newEnd - newStart }
        : null;
    })
    .filter(Boolean);

  const updatedTranscript = {
    ...existing,
    timestamps,
    mutedSegments: remainingMuted,
  };
  writeTranscript(name, updatedTranscript);

  // Replace the original file with the trimmed result — the original content is gone.
  // Force-close any open preview stream first; Windows otherwise keeps the file
  // locked and the rename fails even after several retries.
  closeActiveStreamReaders(name);
  try {
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    trimProgress.delete(name);
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    return res.status(500).json({
      error: `Schnitt fertig, aber die Datei war noch gesperrt (z. B. durch die Vorschau): ${err.message}`,
    });
  }

  const thumbPath = path.join(THUMBS_DIR, `${name}.jpg`);
  try {
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  } catch {}

  trimProgress.delete(name);
  res.json({ transcript: updatedTranscript });
}

// Polled by the frontend while a trim is running to render a percentage.
videosRouter.get('/videos/:name/trim-progress', (req, res) => {
  const name = path.basename(req.params.name);
  const progress = trimProgress.has(name) ? trimProgress.get(name) : null;
  res.json({ progress, queued: trimsWaiting.has(name) });
});

videosRouter.delete('/videos/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(VIDEOS_DIR, name);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  const thumbPath = path.join(THUMBS_DIR, `${name}.jpg`);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${name}.json`);
  if (fs.existsSync(transcriptPath)) fs.unlinkSync(transcriptPath);
  const entry = db.getPlaylistEntryByFilename(name);
  if (entry) db.removePlaylistEntry(entry.id);
  res.json({ deleted: name });
});

videosRouter.get('/videos/:name/stream', (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(VIDEOS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const { size } = fs.statSync(filePath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'video/mp4' });
    pipeVideoStream(name, fs.createReadStream(filePath), res);
    return;
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  let start = parseInt(startStr, 10);
  let end = endStr ? parseInt(endStr, 10) : size - 1;
  if (startStr === '' && Number.isFinite(end)) {
    // suffix range "bytes=-N": the last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
  });
  pipeVideoStream(name, fs.createReadStream(filePath, { start, end }), res);
});

videosRouter.get('/thumbnails/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const videoPath = path.resolve(VIDEOS_DIR, filename);
  if (!fs.existsSync(videoPath)) return res.status(404).end();

  const thumbPath = path.join(THUMBS_DIR, `${filename}.jpg`);
  if (fs.existsSync(thumbPath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(thumbPath);
  }

  if (generatingThumbs.has(filename)) return res.status(202).end();

  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  generatingThumbs.add(filename);

  const proc = spawn(
    FFMPEG_PATH,
    [
      '-ss',
      '0',
      '-i',
      videoPath,
      '-vframes',
      '1',
      '-vf',
      'scale=320:-1',
      '-f',
      'image2',
      '-y',
      thumbPath,
    ],
    { stdio: 'ignore' },
  );

  proc.on('exit', (code) => {
    generatingThumbs.delete(filename);
    if (code === 0 && fs.existsSync(thumbPath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(thumbPath);
    } else {
      res.status(500).end();
    }
  });
  proc.on('error', () => {
    generatingThumbs.delete(filename);
    res.status(500).end();
  });
});

export default videosRouter;
