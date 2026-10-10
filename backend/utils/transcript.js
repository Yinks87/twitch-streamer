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

export function parseTimestamp(t) {
  if (!t) return 0;
  const parts = String(t).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t) || 0;
}

// The segment (title/category) of a video that is active at `positionSecs` into the video.
export function getSegmentAt(meta, positionSecs) {
  const timestamps = Array.isArray(meta?.timestamps)
    ? meta.timestamps
        .map((ts, index) => ({ ts, index, secs: parseTimestamp(ts?.time) }))
        .sort((a, b) => a.secs - b.secs || a.index - b.index)
    : [];
  if (timestamps.length === 0) return null;
  let current = timestamps[0];
  for (const candidate of timestamps) {
    if (candidate.secs <= positionSecs) current = candidate;
    else break;
  }
  return {
    index: timestamps.indexOf(current),
    total: timestamps.length,
    time: current.ts.time ?? '00:00:00',
    title: current.ts.title || '',
    category: current.ts.category || '',
  };
}

// A transcript is incomplete (and must not be streamed) if any timestamp has no category set —
// the category drives the live Twitch channel-update calls on each video/segment switch.
export function transcriptNeedsCategory(meta) {
  const timestamps = meta?.timestamps;
  if (!Array.isArray(timestamps) || timestamps.length === 0) return true;
  return timestamps.some((ts) => !ts?.category || !String(ts.category).trim());
}
