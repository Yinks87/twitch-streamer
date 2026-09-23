import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';

import config from '../../config.js';
import * as db from '../../db.js';
import * as streamManager from '../../streamManager.js';

const thumbsRouter = express.Router();

const { VIDEOS_DIR, THUMBS_DIR, FFMPEG_PATH } = config;

thumbsRouter.get('/:filename', (req, res) => {
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


export default thumbsRouter;