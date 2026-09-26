import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

const { VIDEOS_DIR, FFMPEG_PATH } = config;
const THUMBS_DIR = path.join(path.resolve(VIDEOS_DIR), '.thumbs');
const generatingThumbs = new Set();

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
  destination: (req, file, cb) => cb(null, VIDEOS_DIR),
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
  res.json({ videos: files });
});

videosRouter.post('/upload', upload.array('videos', 50), (req, res) => {
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
    timestamps[0].category = timestamps[0].category || firstTimestamp.category;
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
});

videosRouter.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err)
    return res.status(400).json({ error: err.message });
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

  const updated = { timestamps };
  writeTranscript(name, updated);

  const entry = db.getPlaylistEntryByFilename(name);
  if (entry) {
    const fields = { enabled: transcriptNeedsCategory(updated) ? 0 : 1 };
    if (first.title) fields.title = first.title;
    db.updatePlaylistEntry(entry.id, fields);
  }
  res.json({ transcript: updated });
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
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
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
