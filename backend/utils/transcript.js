import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

export const TRANSCRIPTS_DIR = path.join(path.resolve(config.VIDEOS_DIR), '.transcripts');

export function readTranscript(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, `${filename}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

export function writeTranscript(filename, meta) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${filename}.json`), JSON.stringify(meta, null, 2));
}

// A transcript is incomplete (and must not be streamed) if any timestamp has no category set —
// the category drives the live Twitch channel-update calls on each video/segment switch.
export function transcriptNeedsCategory(meta) {
  const timestamps = meta?.timestamps;
  if (!Array.isArray(timestamps) || timestamps.length === 0) return true;
  return timestamps.some((ts) => !ts?.category || !String(ts.category).trim());
}
