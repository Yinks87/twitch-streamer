// Scheduled restarts notify chat before ffmpeg stops; videoChanged remains the
// only event that updates channel metadata for the next stream/video start.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

import config from './config.js';
import * as db from './db/db.js';
import {
  readTranscript,
  transcriptNeedsCategory,
  getSegmentAt,
} from './utils/transcript.js';
import { getStreamLiveStatus } from './twitch/api.js';

const STALL_AFTER_MS = 10_000;
const LIVE_CHECK_INTERVAL_MS = 15_000;
const WATCHDOG_STALL_MS = 30_000;
const MAX_LAG_SECS = 60;
const MAX_PLAYLIST_ENTRIES = 20_000;
// Twitch needs a moment after the first RTMP data before /streams reports the channel live.
const LIVE_GRACE_MS = 60_000;
let lastProgressAt = 0;
let liveCheckTimer = null;
let twitchHealth = { live: null, reachable: null, checkedAt: null };

function stopLiveCheck() {
  if (liveCheckTimer) clearInterval(liveCheckTimer);
  liveCheckTimer = null;
  twitchHealth = { live: null, reachable: null, checkedAt: null };
}

function startLiveCheck() {
  stopLiveCheck();
  const check = async () => {
    // ffmpeg can hang (process alive, no output) when the looping playlist re-opens itself.
    // Killing it triggers the exit handler's reconnect, which resumes the stream.
    if (
      ffmpegProcess &&
      activeStreamConfig &&
      Date.now() - lastProgressAt > WATCHDOG_STALL_MS
    ) {
      pushLog(
        `No ffmpeg progress for ${WATCHDOG_STALL_MS / 1000}s; restarting ffmpeg.`,
      );
      lastProgressAt = Date.now();
      ffmpegProcess.kill('SIGKILL');
      return;
    }
    // ffmpeg running far behind real time (viewers only see buffering) never catches up
    // by itself; restarting resumes at the current position with a clean pipeline.
    const sinceStartSecs = startedAt
      ? (Date.now() - Date.parse(startedAt)) / 1000
      : 0;
    if (
      ffmpegProcess &&
      activeStreamConfig &&
      sinceStartSecs - lastOutputTimeSecs > MAX_LAG_SECS
    ) {
      pushLog(
        `ffmpeg is ${Math.round(sinceStartSecs - lastOutputTimeSecs)}s behind real time; restarting ffmpeg.`,
      );
      ffmpegProcess.kill('SIGKILL');
      return;
    }
    const result = await getStreamLiveStatus();
    if (!liveCheckTimer) return;
    twitchHealth = { ...result, checkedAt: new Date().toISOString() };
  };
  liveCheckTimer = setInterval(check, LIVE_CHECK_INTERVAL_MS);
  check();
}

const FFMPEG_PATH = config.FFMPEG_PATH;
// Twitch allows up to 8000 kbps / 60 fps; matches OBS's default "veryfast" x264 profile.
// ffprobe lives next to ffmpeg
const FFPROBE_PATH = FFMPEG_PATH.replace(
  /ffmpeg(\.exe)?$/i,
  (_, ext) => `ffprobe${ext ?? ''}`,
);
export const VIDEOS_DIR = config.VIDEOS_DIR;
const LOGS_DIR = config.LOGS_DIR || path.join(process.cwd(), 'logs');
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.mov',
  '.flv',
  '.ts',
  '.webm',
  '.avi',
]);

const MAX_LOG_LINES = 200;
const MAX_LOG_FILE_BYTES = 1_000_000;

// Emits 'videoChanged' with the filename whenever ffmpeg opens a new video file.
// The initial event on reconnect also includes the saved in-video offset.
export const streamEvents = new EventEmitter();

let ffmpegProcess = null;
let startedAt = null;
let logBuffer = [];
// Unrestricted, per-ffmpeg-process log lines, flushed to disk on exit.
let sessionLogLines = [];
let lastExit = null;
// Stored while streaming so the exit handler can restart for looping.
let activeStreamConfig = null;
let activeLoopPlaylistPath = null;
let pendingLoopPlaylistState = null;
let resumeState = null;
// RTMP timestamp base of the current session (seconds already streamed before it).
let outputTsOffsetSecs = 0;
let currentVideoFilename = '';
let currentVideoStartSecs = 0;
let currentVideoBaseOffset = 0;
let lastOutputTimeSecs = 0;
// Timers that fire videoChanged on each video transition.
let videoChangeTimers = [];
let reconnectTimer = null;
let scheduledRestartTimer = null;
let scheduledRestartAt = null;
let scheduledRestartRequested = false;
let offlineRestartRequested = false;
let lastScheduledRestartMs = 0;

function clearVideoChangeTimers() {
  videoChangeTimers.forEach(clearTimeout);
  videoChangeTimers = [];
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearScheduledRestartTimer() {
  if (scheduledRestartTimer) clearTimeout(scheduledRestartTimer);
  scheduledRestartTimer = null;
  scheduledRestartAt = null;
}

// Progress-based transition state (driven by ffmpeg stdout, not wall-clock timers).
let transitionTimes = []; // [{atSecs, filename}] relative times within one cycle
let nextTransitionIdx = 0;
let totalDuration = 0; // sum of all video durations in one cycle
let cycleOffset = 0; // outTimeSecs at which the current cycle started
let loopFirstFile = ''; // filename of entries[0] for cycle-restart events

function resetTransitionState() {
  transitionTimes = [];
  nextTransitionIdx = 0;
  totalDuration = 0;
  cycleOffset = 0;
  loopFirstFile = '';
}

// Uploaded/downloaded files are immutable (UUID names), so probe results can be cached
// forever Ã¢â‚¬â€ this makes reconnects near-instant instead of re-probing the whole playlist.
const probeCache = new Map();

function probeVideo(filepath) {
  // Trimming replaces a file in place, so the key includes mtime and size.
  let cacheKey;
  try {
    const stat = fs.statSync(filepath);
    cacheKey = `${filepath}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    return Promise.resolve(null);
  }
  if (probeCache.has(cacheKey))
    return Promise.resolve(probeCache.get(cacheKey));
  return new Promise((resolve) => {
    execFile(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,extradata_hash',
        '-show_data_hash',
        'MD5',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        filepath,
      ],
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const dur = parseFloat(data?.format?.duration);
          const streams = data?.streams ?? [];
          const stream = streams.find((s) => s.codec_type === 'video') ?? {};
          const audio = streams.find((s) => s.codec_type === 'audio');
          const info = {
            duration: Number.isFinite(dur) ? dur : null,
            width: Number(stream.width) || null,
            height: Number(stream.height) || null,
            videoCodec: stream.codec_name ?? null,
            videoExtradataHash: stream.extradata_hash ?? null,
            audioCodec: audio?.codec_name ?? null,
          };
          probeCache.set(cacheKey, info);
          resolve(info);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// The concat demuxer reuses the first file's decoder (and its SPS/PPS from the mp4 header)
// for every following file. When files differ in codec or H.264 parameter sets the picture
// of later files is decoded as garbage: timestamps explode or the picture freezes while the
// audio keeps going. Mixed playlists are therefore remuxed (H.264 copy with in-band
// SPS/PPS) or converted (other codecs) to MPEG-TS once and cached.
const STREAM_CACHE_DIRNAME = '.stream-cache';
const conversions = new Map();

// A cache file is stale when its source was replaced afterwards (trimming works in place).
function isCacheCurrent(source, target) {
  try {
    return fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

// Removes the cached MPEG-TS copy of a video (e.g. after it was deleted or trimmed).
// Failures (file still in use by a running stream) are retried by the cleanup at the
// next stream start.
export function removeStreamCacheFor(filename) {
  const target = path.resolve(VIDEOS_DIR, STREAM_CACHE_DIRNAME, `${filename}.ts`);
  if (conversions.has(target)) return;
  for (const file of [target, `${target}.part`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

function convertForConcat(filename, probe) {
  const source = path.resolve(VIDEOS_DIR, filename);
  const cacheDir = path.resolve(VIDEOS_DIR, STREAM_CACHE_DIRNAME);
  const target = path.join(cacheDir, `${filename}.ts`);
  if (conversions.has(target)) return conversions.get(target);
  if (fs.existsSync(target)) {
    if (isCacheCurrent(source, target)) return Promise.resolve();
    fs.rmSync(target, { force: true });
  }

  const partial = `${target}.part`;
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-i',
    source,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...(probe.videoCodec === 'h264'
      ? ['-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb']
      : [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '18',
          '-pix_fmt',
          'yuv420p',
        ]),
    ...(probe.audioCodec === 'aac'
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']),
    '-f',
    'mpegts',
    partial,
  ];
  pushLog(
    `Preparing ${filename} (${probe.videoCodec}/${probe.audioCodec ?? 'no audio'}) for seamless playback (one-time).`,
  );
  const job = new Promise((resolve, reject) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    execFile(
      FFMPEG_PATH,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          fs.rmSync(partial, { force: true });
          reject(
            new Error(`Preparing ${filename} failed: ${stderr || err.message}`),
          );
          return;
        }
        fs.renameSync(partial, target);
        resolve();
      },
    );
  }).finally(() => conversions.delete(target));
  conversions.set(target, job);
  return job;
}

// Returns the playlist paths (relative to VIDEOS_DIR) that can be safely concatenated.
// Files are used as-is when they all share one codec and H.264 parameter set; otherwise
// every file goes through the MPEG-TS cache so no file relies on another one's header.
async function getPlayableNames(entries, probes) {
  const signatures = probes.map((p) =>
    p?.videoCodec
      ? `${p.videoCodec}|${p.videoExtradataHash}|${p.audioCodec ?? ''}`
      : null,
  );
  const uniform =
    signatures.every((s) => s !== null && s === signatures[0]) &&
    probes[0].videoCodec === 'h264' &&
    (!probes[0].audioCodec || probes[0].audioCodec === 'aac');
  if (uniform || signatures.some((s) => s === null)) {
    return entries.map(({ filename }) => filename);
  }
  const names = [];
  for (let i = 0; i < entries.length; i++) {
    await convertForConcat(entries[i].filename, probes[i]);
    names.push(`${STREAM_CACHE_DIRNAME}/${entries[i].filename}.ts`);
  }
  return names;
}

// Deletes cache files that are leftovers: partial conversions (when none is running),
// copies of deleted videos and copies older than their (trimmed) source.
function removeOrphanedCacheFiles() {
  const cacheDir = path.resolve(VIDEOS_DIR, STREAM_CACHE_DIRNAME);
  if (!fs.existsSync(cacheDir)) return;
  for (const name of fs.readdirSync(cacheDir)) {
    const cachePath = path.join(cacheDir, name);
    if (name.endsWith('.part')) {
      if (conversions.size === 0) fs.rmSync(cachePath, { force: true });
      continue;
    }
    const sourcePath = path.resolve(VIDEOS_DIR, name.replace(/\.ts$/, ''));
    if (fs.existsSync(sourcePath) && isCacheCurrent(sourcePath, cachePath))
      continue;
    try {
      fs.rmSync(cachePath, { force: true });
    } catch {}
  }
}

function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  sessionLogLines.push(line);
}

// Dumps the full ffmpeg log of the just-ended session to a timestamped .txt file.
function writeSessionLogFile(code, signal) {
  if (sessionLogLines.length === 0) return;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(LOGS_DIR, `stream-${stamp}.txt`);
    const header = `ffmpeg exited (code=${code}, signal=${signal}) at ${new Date().toISOString()}\n\n`;
    fs.writeFileSync(filePath, header + sessionLogLines.join('\n') + '\n');
  } catch (err) {
    console.error('Failed to write ffmpeg session log:', err.message);
  } finally {
    sessionLogLines = [];
  }
}

function getLogFileInfo(filename) {
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    return null;
  }
  if (!/\.(?:log|txt)$/i.test(filename)) return null;

  const filePath = path.join(LOGS_DIR, filename);
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;
    return {
      filename,
      filePath,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export function getLogFilePath(filename) {
  return getLogFileInfo(filename)?.filePath ?? null;
}

export function listLogFiles() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  return fs
    .readdirSync(LOGS_DIR)
    .map(getLogFileInfo)
    .filter(Boolean)
    .sort((first, second) => second.modifiedAt.localeCompare(first.modifiedAt))
    .slice(0, 100)
    .map(({ filename, size, modifiedAt }) => ({ filename, size, modifiedAt }));
}

export function readLogFile(filename) {
  const file = getLogFileInfo(filename);
  if (!file) return null;

  const bytesToRead = Math.min(file.size, MAX_LOG_FILE_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const descriptor = fs.openSync(file.filePath, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, bytesToRead, file.size - bytesToRead);
  } finally {
    fs.closeSync(descriptor);
  }

  return {
    filename: file.filename,
    content: `${file.size > bytesToRead ? '[Earlier log content omitted]\n' : ''}${buffer.toString('utf8')}`,
  };
}

export function deleteLogFile(filename) {
  const filePath = getLogFilePath(filename);
  if (!filePath) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function listVideoFiles() {
  if (!fs.existsSync(VIDEOS_DIR)) return [];
  return fs
    .readdirSync(VIDEOS_DIR)
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

// Builds the ffmpeg concat playlist string from the DB Ã¢â‚¬â€ no file written.
function buildPlaylistContent() {
  const { playlistSource, shuffleMode } = db.getSettings();
  const filter =
    playlistSource === 'all'
      ? null
      : playlistSource === 'uploads_only'
        ? 'upload'
        : ['vod', 'clip'];
  let entries = db
    .getPlaylist(filter)
    .filter(
      (e) =>
        e.enabled &&
        e.status === 'ready' &&
        !transcriptNeedsCategory(readTranscript(e.filename)),
    );

  if (entries.length === 0) {
    throw new Error(
      playlistSource === 'vods_only'
        ? 'No imported VODs/clips in the playlist. Import one first.'
        : playlistSource === 'uploads_only'
          ? 'No uploaded videos in the playlist. Upload a file first.'
          : 'Playlist is empty. Upload a video, import a VOD/clip, or complete a transcript missing its category first.',
    );
  }

  if (shuffleMode) {
    entries = [...entries];
    for (let index = entries.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [entries[index], entries[randomIndex]] = [
        entries[randomIndex],
        entries[index],
      ];
    }
  }

  // Playlist content is built after ffprobe to include duration lines.
  return { entries };
}

function removeStalePlaylistFiles() {
  if (!fs.existsSync(VIDEOS_DIR)) return;
  for (const filename of fs.readdirSync(VIDEOS_DIR)) {
    if (
      !/^twitch-playlist-\d+(?:-loop)?\.txt(?:\.\d+\.\d+\.tmp)?$/.test(filename)
    )
      continue;
    try {
      fs.unlinkSync(path.join(VIDEOS_DIR, filename));
    } catch {}
  }
}

function writePlaylistFile(playlistPath, content) {
  const temporaryPath = `${playlistPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, playlistPath);
}

function setLoopPlaylistState(entries, durations, resumeOffset = 0) {
  let cumulativeSeconds = 0;
  transitionTimes = [];
  for (let index = 0; index < entries.length; index++) {
    const duration = durations[index];
    if (duration == null) break;
    if (index < entries.length - 1) {
      transitionTimes.push({
        atSecs: cumulativeSeconds + duration,
        filename: entries[index + 1].filename,
      });
    }
    cumulativeSeconds += duration;
  }
  totalDuration = cumulativeSeconds;
  loopFirstFile = entries[0].filename;
  nextTransitionIdx = 0;
  while (
    nextTransitionIdx < transitionTimes.length &&
    transitionTimes[nextTransitionIdx].atSecs <= resumeOffset
  ) {
    nextTransitionIdx++;
  }
}

export async function refreshActivePlaylist() {
  const playlistPath = activeLoopPlaylistPath;
  if (!ffmpegProcess || !playlistPath) return false;

  const { entries } = buildPlaylistContent();
  const durations = await Promise.all(
    entries.map(async ({ filename }) => {
      const probe = await probeVideo(path.resolve(VIDEOS_DIR, filename));
      return probe?.duration ?? null;
    }),
  );

  if (!ffmpegProcess || activeLoopPlaylistPath !== playlistPath) return false;

  const escapeName = (name) => name.replace(/'/g, "'\\''");
  const entryLines = entries
    .map(({ filename }, index) => {
      const duration = durations[index];
      let line = `file '${escapeName(filename)}'`;
      if (duration != null) line += `\nduration ${duration}`;
      return line;
    })
    .join('\n');
  const playlistFilename = path.basename(playlistPath);
  writePlaylistFile(
    playlistPath,
    `ffconcat version 1.0\n${entryLines}\nfile '${escapeName(playlistFilename)}'\n`,
  );
  pendingLoopPlaylistState = { entries, durations };
  pushLog(
    `Playlist updated; ${entries.length} item(s) will play in the next loop.`,
  );
  return true;
}

function isRunning() {
  return ffmpegProcess !== null;
}

// Position inside the current video is derived from the encoder progress, the same basis
// that drives the Twitch channel updates. The transcript is read on every call so edits
// made while streaming show up immediately.
function getCurrentSegment() {
  if (!currentVideoFilename) return null;
  const position =
    currentVideoBaseOffset +
    Math.max(0, lastOutputTimeSecs - currentVideoStartSecs);
  const segment = getSegmentAt(readTranscript(currentVideoFilename), position);
  return segment ? { ...segment, positionSecs: position } : null;
}

export function getStatus() {
  const running = isRunning();
  const sinceStart = startedAt ? Date.now() - Date.parse(startedAt) : 0;
  const stalled =
    running &&
    sinceStart > STALL_AFTER_MS &&
    Date.now() - lastProgressAt > STALL_AFTER_MS;
  // 'ok' | 'stalled' (ffmpeg not delivering) | 'offline' (Twitch reports channel not live)
  // | 'unreachable' (Twitch API unreachable, e.g. internet outage) | 'connecting' | null
  let health = null;
  if (running) {
    if (stalled) health = 'stalled';
    else if (twitchHealth.reachable === false) health = 'unreachable';
    else if (twitchHealth.live === false)
      health = sinceStart > LIVE_GRACE_MS ? 'offline' : 'connecting';
    else if (twitchHealth.live === true) health = 'ok';
    else health = 'connecting';
  }
  return {
    running,
    reconnecting: !running && Boolean(reconnectTimer),
    health,
    twitchCheckedAt: twitchHealth.checkedAt,
    startedAt,
    pid: ffmpegProcess ? ffmpegProcess.pid : null,
    lastExit,
    scheduledRestartAt,
    log: logBuffer.slice(-50),
    videoCount: listVideoFiles().length,
    currentVideo: isRunning() ? currentVideoFilename || null : null,
    currentSegment: isRunning() ? getCurrentSegment() : null,
  };
}

const PACKET_NOISE_RE = /\bpts[=:]\s*[-\d]|\bdts[=:]\s*[-\d]|\bpos[=:]\s*\d/;

export async function startStream({
  twitchServer,
  streamKey,
  loop = true,
  videoBitrateKbps = 6000,
  audioBitrateKbps = 128,
  streamFps = 60,
  encoderPreset = 'veryfast',
  restartIntervalSeconds = 169200,
  restartDelaySeconds = 5,
  resumeFrom = null,
}) {
  if (isRunning())
    throw new Error(
      'A stream is already running. Stop it before starting a new one.',
    );
  if (!streamKey) throw new Error('No Twitch stream key configured.');
  const keyframeIntervalFrames = streamFps * 2;
  clearReconnectTimer();
  clearScheduledRestartTimer();
  scheduledRestartRequested = false;
  offlineRestartRequested = false;
  removeStalePlaylistFiles();

  const { entries: playlistEntries } = buildPlaylistContent();
  const resumeIndex = resumeFrom
    ? playlistEntries.findIndex(
        (entry) => entry.filename === resumeFrom.filename,
      )
    : -1;
  const entries =
    resumeIndex >= 0
      ? [
          ...playlistEntries.slice(resumeIndex),
          ...playlistEntries.slice(0, resumeIndex),
        ]
      : playlistEntries;
  let resumeOffset =
    resumeIndex >= 0 ? Math.max(0, Number(resumeFrom.offset) || 0) : 0;
  // OBS keeps output timestamps monotonic across RTMP reconnects, so Twitch treats the new
  // connection as a continuation of the same broadcast instead of a fresh video signal that
  // resets the playtime. Mirror that by offsetting all mux timestamps by the total time
  // already streamed (progress out_time stays session-relative, verified with ffmpeg 8).
  const outputTsOffset = resumeFrom
    ? Math.max(0, Number(resumeFrom.outputOffsetSecs) || 0)
    : 0;
  outputTsOffsetSecs = outputTsOffset;
  const target = `${twitchServer.replace(/\/+$/, '')}/${streamKey}`;

  activeStreamConfig = {
    twitchServer,
    streamKey,
    loop,
    videoBitrateKbps,
    audioBitrateKbps,
    streamFps,
    encoderPreset,
    restartIntervalSeconds,
    restartDelaySeconds,
  };

  // Pre-fetch durations/resolutions so the concat playlist can include explicit duration lines
  // (prevents non-monotonic DTS at file boundaries) and for transition tracking.
  const probes = await Promise.all(
    entries.map(({ filename }) =>
      probeVideo(path.resolve(VIDEOS_DIR, filename)),
    ),
  );
  const durations = probes.map((p) => p?.duration ?? null);

  removeOrphanedCacheFiles();
  const playableNames = await getPlayableNames(entries, probes);
  // stopStream() may have been called while files were being converted.
  if (!activeStreamConfig) return getStatus();
  // Never resume past the end of the file (stale offsets would create an empty segment).
  if (resumeOffset > 0 && durations[0] != null) {
    resumeOffset = Math.min(resumeOffset, Math.max(durations[0] - 0.5, 0));
  }

  // OBS-style fixed canvas: pick the largest source resolution, capped at Twitch's 1080p
  // guideline, and normalize every video to it so the encoder never reconfigures mid-stream
  // (a mid-stream resolution change makes Twitch drop the ingest connection).
  let canvasW = 1920;
  let canvasH = 1080;
  const withDims = probes.filter((p) => p?.width && p?.height);
  if (withDims.length > 0) {
    const largest = withDims.reduce((a, b) =>
      b.width * b.height > a.width * a.height ? b : a,
    );
    const fit = Math.min(1920 / largest.width, 1080 / largest.height, 1);
    canvasW = Math.max(2, Math.round((largest.width * fit) / 2) * 2);
    canvasH = Math.max(2, Math.round((largest.height * fit) / 2) * 2);
  }

  // The playlists live inside VIDEOS_DIR and reference bare filenames: the concat demuxer
  // resolves relative paths against the script location, and relative paths count as "safe".
  const playlistDir = path.resolve(VIDEOS_DIR);
  const stamp = Date.now();
  const escapeName = (name) => name.replace(/'/g, "'\\''");
  // ffconcat v1.0 with per-file duration lines lets the demuxer calculate exact timestamp offsets.
  const entryLines = (inpoint) =>
    entries
      .map((_, i) => {
        const dur = durations[i];
        const ip = i === 0 ? inpoint : 0;
        let s = `file '${escapeName(playableNames[i])}'`;
        if (ip > 0) s += `\ninpoint ${ip}`;
        if (dur != null) s += `\nduration ${Math.max(dur - ip, 0)}`;
        return s;
      })
      .join('\n');

  // Looping happens inside a single ffmpeg run: the playlist repeats the entries enough
  // times to outlast the next scheduled restart. Restarting ffmpeg at every loop would
  // cleanly close the RTMP connection, so Twitch would show the stream offline/online and
  // reset the stream timer. (A self-referencing playlist made the timestamps explode.)
  // Resume uses `inpoint` on the first (rotated) entry, a fast in-file mp4 seek.
  const playlistFilename = `twitch-playlist-${stamp}.txt`;
  const playlistPath = path.join(playlistDir, playlistFilename);
  const playlistPaths = [playlistPath];
  const cycleSecs = durations.reduce((sum, d) => sum + (d ?? 0), 0);
  const coverageSecs =
    restartIntervalSeconds > 0 ? restartIntervalSeconds * 1.1 : 7 * 86400;
  const repeats = loop
    ? Math.max(
        1,
        Math.min(
          Math.ceil(coverageSecs / Math.max(cycleSecs, 1)),
          Math.floor(MAX_PLAYLIST_ENTRIES / entries.length),
        ),
      )
    : 1;
  const content = `ffconcat version 1.0\n${[
    entryLines(resumeOffset),
    ...Array.from({ length: repeats - 1 }, () => entryLines(0)),
  ].join('\n')}\n`;
  writePlaylistFile(playlistPath, content);
  // Mid-stream playlist edits apply at the next ffmpeg restart.
  activeLoopPlaylistPath = null;
  pendingLoopPlaylistState = null;

  const baseArgs = [
    '-loglevel',
    'warning',
    // Regenerate broken/missing timestamps from source files before they hit our own filters.
    '-fflags',
    '+genpts',
    '-re',
    '-thread_queue_size',
    '1024',
    '-progress',
    'pipe:1',
    '-protocol_whitelist',
    'file,pipe,crypto,data',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    playlistPath,
  ];

  // OBS paces frames from a fixed frame counter (frame_time = N / fps) rather than trusting
  // source timestamps. `scale`+`pad`+`setsar` normalize every source to the fixed canvas,
  // `fps` normalizes to the configured FPS, `setpts`/`asetpts` rebuild presentation timestamps
  // purely from the output sample count, and `format` pins the pixel format Ã¢â‚¬â€ this guarantees a
  // perfectly monotonic, evenly spaced, constant-parameter stream regardless of how the
  // concatenated source files were encoded (mixed resolution/fps/pix_fmt/timestamps no longer
  // reach the encoder or Twitch).
  const filterArgs = [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=decrease,` +
      `pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
      `fps=${streamFps},setpts=N/(${streamFps}*TB),format=yuv420p`,
    '-af',
    'aresample=async=1:first_pts=0,asetpts=N/SR/TB',
  ];

  const encoderArgs = [
    '-c:v',
    'libx264',
    '-preset',
    encoderPreset,
    '-profile:v',
    'high',
    '-level:v',
    '4.2',
    '-pix_fmt',
    'yuv420p',
    // Fixed GOP in frames (not wall-clock expressions) so keyframes land at an exact,
    // unchanging interval regardless of source irregularities.
    '-g',
    String(keyframeIntervalFrames),
    '-keyint_min',
    String(keyframeIntervalFrames),
    '-sc_threshold',
    '0',
    '-bf',
    '2',
    '-b:v',
    `${videoBitrateKbps}k`,
    '-minrate',
    `${videoBitrateKbps}k`,
    '-maxrate',
    `${videoBitrateKbps}k`,
    '-bufsize',
    `${videoBitrateKbps}k`,
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1',
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-ar',
    '48000',
    '-ac',
    '2',
  ];

  const muxArgs = [
    '-map_metadata',
    '-1',
    '-flvflags',
    'no_duration_filesize',
    '-flush_packets',
    '1',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-max_muxing_queue_size',
    '1024',
    ...(outputTsOffset > 0
      ? ['-output_ts_offset', outputTsOffset.toFixed(3)]
      : []),
    // Fail a stalled RTMP connection within 15s instead of hanging, so the automatic
    // reconnect lands well inside Twitch's ~90s disconnect protection window and the
    // channel never goes offline.
    '-rw_timeout',
    '15000000',
  ];

  const args = [
    ...baseArgs,
    ...filterArgs,
    ...encoderArgs,
    ...muxArgs,
    '-f',
    'flv',
    target,
  ];

  logBuffer = [];
  sessionLogLines = [];
  pushLog(`Starting stream with ${entries.length} item(s)`);

  // stdin not needed Ã¢â‚¬â€ input comes from the temp file. cwd doubles as a fallback for
  // resolving the playlist's relative entries.
  ffmpegProcess = spawn(FFMPEG_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(VIDEOS_DIR),
  });
  startedAt = new Date().toISOString();
  lastExit = null;
  lastProgressAt = Date.now();
  startLiveCheck();

  if (restartIntervalSeconds > 0) {
    scheduledRestartAt = new Date(
      Date.now() + restartIntervalSeconds * 1000,
    ).toISOString();
    scheduledRestartTimer = setTimeout(() => {
      scheduledRestartTimer = null;
      scheduledRestartAt = null;
      if (!ffmpegProcess || !activeStreamConfig) return;
      scheduledRestartRequested = true;
      streamEvents.emit('scheduledRestart', {
        delaySeconds: activeStreamConfig.restartDelaySeconds,
      });
      pushLog(
        'Scheduled restart reached; stopping ffmpeg at the current video position.',
      );
      ffmpegProcess.kill('SIGINT');
    }, restartIntervalSeconds * 1000);
  }

  // Populate transition state from pre-fetched durations Ã¢â‚¬â€ no second ffprobe needed.
  resetTransitionState();
  loopFirstFile = entries[0].filename;
  currentVideoFilename = entries[0].filename;
  currentVideoStartSecs = 0;
  currentVideoBaseOffset = resumeOffset;
  lastOutputTimeSecs = 0;
  {
    setLoopPlaylistState(entries, durations, resumeOffset);
    // The resumed portion counts as already-elapsed cycle time, so the shortened first
    // cycle and all full later cycles share one set of transition times.
    cycleOffset = -resumeOffset;
  }

  streamEvents.emit('videoChanged', entries[0].filename, {
    resumed: Boolean(resumeFrom),
    offset: resumeOffset,
  });

  let stdoutBuf = '';
  ffmpegProcess.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const m = line.match(/^out_time=(\d+):(\d+):([\d.]+)$/);
      if (!m) continue;
      const outTimeSecs =
        parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      if (outTimeSecs > lastOutputTimeSecs) lastProgressAt = Date.now();
      lastOutputTimeSecs = Math.max(lastOutputTimeSecs, outTimeSecs);
      // Detect when we've crossed into the next repetition of the playlist.
      if (loop && totalDuration > 0) {
        while (outTimeSecs >= cycleOffset + totalDuration) {
          cycleOffset += totalDuration;
          nextTransitionIdx = 0;
          if (activeStreamConfig) {
            currentVideoBaseOffset = 0;
            currentVideoStartSecs = cycleOffset;
            currentVideoFilename = loopFirstFile;
            streamEvents.emit('videoChanged', loopFirstFile);
          }
        }
      }
      const timeInCycle = outTimeSecs - cycleOffset;
      while (
        nextTransitionIdx < transitionTimes.length &&
        timeInCycle >= transitionTimes[nextTransitionIdx].atSecs
      ) {
        if (activeStreamConfig) {
          currentVideoFilename = transitionTimes[nextTransitionIdx].filename;
          currentVideoStartSecs =
            cycleOffset + transitionTimes[nextTransitionIdx].atSecs;
          currentVideoBaseOffset = 0;
          streamEvents.emit(
            'videoChanged',
            transitionTimes[nextTransitionIdx].filename,
          );
        }
        nextTransitionIdx++;
      }
    }
  });

  ffmpegProcess.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      if (!PACKET_NOISE_RE.test(line)) {
        pushLog(
          streamKey
            ? line.split(streamKey).join('[REDACTED_STREAM_KEY]')
            : line,
        );
      }
    }
  });

  ffmpegProcess.on('exit', async (code, signal) => {
    const restartConfig = activeStreamConfig;
    stopLiveCheck();
    const isScheduledRestart = scheduledRestartRequested;
    const isOfflineRestart = offlineRestartRequested;
    scheduledRestartRequested = false;
    offlineRestartRequested = false;
    if (isScheduledRestart) lastScheduledRestartMs = Date.now();
    clearScheduledRestartTimer();
    const playlistFinished =
      code === 0 && !signal && !isScheduledRestart && !isOfflineRestart;
    if (restartConfig && playlistFinished) {
      if (!restartConfig.loop) {
        activeStreamConfig = null;
      } else {
        // Whole playlist played: start the next cycle from the first entry while keeping
        // the output timestamps continuous so Twitch sees one uninterrupted broadcast.
        resumeState = {
          filename: null,
          offset: 0,
          outputOffsetSecs: outputTsOffsetSecs + lastOutputTimeSecs,
        };
      }
    } else if (restartConfig && currentVideoFilename) {
      resumeState = {
        filename: currentVideoFilename,
        offset:
          currentVideoBaseOffset +
          Math.max(0, lastOutputTimeSecs - currentVideoStartSecs),
        // Scheduled restarts must look like a brand-new broadcast (Twitch's 48h cap), so
        // only unexpected drops carry the timestamp continuation. After Twitch reported the
        // stream offline the broadcast is over, so the restart starts a fresh one as well.
        outputOffsetSecs:
          isScheduledRestart || isOfflineRestart
            ? 0
            : outputTsOffsetSecs + lastOutputTimeSecs,
      };
    }
    clearVideoChangeTimers();
    resetTransitionState();
    activeLoopPlaylistPath = null;
    pendingLoopPlaylistState = null;
    for (const p of playlistPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    lastExit = { code, signal, at: new Date().toISOString() };
    pushLog(`ffmpeg exited (code=${code}, signal=${signal})`);
    if (resumeState?.filename) {
      pushLog(
        `Saving resume point: ${resumeState.filename} at ${resumeState.offset.toFixed(2)}s`,
      );
    }
    writeSessionLogFile(code, signal);
    ffmpegProcess = null;
    startedAt = null;
    if (!restartConfig || !activeStreamConfig) return;

    const reconnectDelaySeconds = isScheduledRestart
      ? restartConfig.restartDelaySeconds
      : playlistFinished
        ? 0
        : 2;
    pushLog(
      isScheduledRestart
        ? `Scheduled restart; resuming in ${reconnectDelaySeconds} seconds.`
        : playlistFinished
          ? 'Playlist finished; starting the next loop.'
          : `RTMP connection ended; reconnecting in ${reconnectDelaySeconds} seconds.`,
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!activeStreamConfig || isRunning()) return;
      startStream({ ...restartConfig, resumeFrom: resumeState })
        .then(() => {
          resumeState = null;
        })
        .catch((err) => {
          pushLog(`Reconnect failed: ${err.message}`);
        });
    }, reconnectDelaySeconds * 1000);
  });

  ffmpegProcess.on('error', (err) => {
    stopLiveCheck();
    clearScheduledRestartTimer();
    pushLog(`Failed to start ffmpeg: ${err.message}`);
    activeLoopPlaylistPath = null;
    pendingLoopPlaylistState = null;
    ffmpegProcess = null;
    startedAt = null;
  });

  return getStatus();
}

export function stopStream() {
  clearVideoChangeTimers();
  clearReconnectTimer();
  clearScheduledRestartTimer();
  scheduledRestartRequested = false;
  offlineRestartRequested = false;
  resetTransitionState();
  activeStreamConfig = null; // prevent the exit handler from restarting
  resumeState = null;
  if (!isRunning()) return getStatus();
  ffmpegProcess.kill('SIGINT');
  streamEvents.emit('streamStopped');
  return getStatus();
}

const OFFLINE_IGNORE_AFTER_SCHEDULED_RESTART_MS = 180_000;

// Called on EventSub stream.offline. Restarts the stream at the last video position
// unless the stop was intentional (frontend stop) or part of a scheduled restart.
export function handleStreamOffline() {
  if (!activeStreamConfig) return { restarted: false, reason: 'not-streaming' };
  if (scheduledRestartRequested)
    return { restarted: false, reason: 'scheduled-restart' };
  const ignoreMs =
    OFFLINE_IGNORE_AFTER_SCHEDULED_RESTART_MS +
    activeStreamConfig.restartDelaySeconds * 1000;
  if (Date.now() - lastScheduledRestartMs < ignoreMs)
    return { restarted: false, reason: 'scheduled-restart' };
  if (reconnectTimer) return { restarted: false, reason: 'reconnect-pending' };
  if (offlineRestartRequested)
    return { restarted: false, reason: 'restart-pending' };

  if (isRunning()) {
    pushLog(
      'Twitch reported the stream offline; restarting ffmpeg at the current video position.',
    );
    offlineRestartRequested = true;
    ffmpegProcess.kill('SIGINT');
    return { restarted: true };
  }

  // ffmpeg is gone and no reconnect is scheduled (e.g. an earlier reconnect failed).
  pushLog('Twitch reported the stream offline; restarting from resume point.');
  startStream({ ...activeStreamConfig, resumeFrom: resumeState })
    .then(() => {
      resumeState = null;
    })
    .catch((err) => {
      pushLog(`Restart after offline failed: ${err.message}`);
    });
  return { restarted: true };
}
