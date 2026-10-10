import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import * as db from '../db/db.js';

const GIB = 1024 ** 3;
const VIDEOS_DIR = path.resolve(config.VIDEOS_DIR);
const STAGING_DIRS = ['.uploading', '.downloading', '.trimming'];

function directorySize(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    else if (entry.isFile()) total += fs.statSync(entryPath).size;
  }
  return total;
}

export function getStorageUsedBytes() {
  if (!fs.existsSync(VIDEOS_DIR)) return 0;
  const mediaExtensions = new Set([
    '.mp4',
    '.mkv',
    '.mov',
    '.flv',
    '.ts',
    '.webm',
    '.avi',
  ]);
  let total = 0;
  for (const entry of fs.readdirSync(VIDEOS_DIR, { withFileTypes: true })) {
    const entryPath = path.join(VIDEOS_DIR, entry.name);
    if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase()))
      total += fs.statSync(entryPath).size;
    else if (entry.isDirectory() && STAGING_DIRS.includes(entry.name))
      total += directorySize(entryPath);
  }
  return total;
}

export function getStorageStatus() {
  const usedBytes = getStorageUsedBytes();
  const limitBytes = db.getSettings().maxStorageGb * GIB;
  return {
    usedBytes,
    limitBytes,
    availableBytes: Math.max(0, limitBytes - usedBytes),
  };
}
