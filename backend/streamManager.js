import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import config from './config.js';
import * as db from './db/db.js';
import {
  readTranscript,
  transcriptNeedsCategory,
  getSegmentAt,
  parseTimestamp,
} from './utils/transcript.js';
import { getStreamLiveStatus } from './twitch/api.js';
import TwitchStreamer from './twitch-streamer.js';

const LIVE_CHECK_INTERVAL_MS = 15_000;
const STALL_AFTER_MS = 10_000;
// Twitch needs a moment after the first RTMP data before /streams reports the channel live.
const LIVE_GRACE_MS = 60_000;
const RELAUNCH_RETRY_SECS = 30;
const OFFLINE_IGNORE_AFTER_SCHEDULED_RESTART_MS = 180_000;
const SESSION_LOG_MAX_LINES = 30_000;
const SESSION_LOG_KEEP_HEAD = 2_000;
const MAX_LOG_FILES = 200;
const MAX_LOG_LINES = 200;
const MAX_LOG_FILE_BYTES = 1_000_000;
const PACKET_NOISE_RE = /\bpts[=:]\s*[-\d]|\bdts[=:]\s*[-\d]|\bpos[=:]\s*\d/;

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

export const streamEvents = new EventEmitter();

const FFMPEG_PID_FILE = path.join(
  path.resolve(config.VIDEOS_DIR),
  '.ffmpeg.pid',
);

let streamer = null; // running TwitchStreamer engine
let shutdownPromise = null; // engine that is still shutting down
let activeStreamConfig = null; // options of the stream that should be running
let startGeneration = 0; // bumped by start/stop to cancel pending launches
let startingStream = false;
let relaunchTimer = null;
let scheduledRestartTimer = null;
let scheduledRestartAt = null;
let lastScheduledRestartMs = 0;
let scheduledRestartPending = false; // set until the relaunch after a scheduled restart succeeded
let startedAt = null;
let resumeState = null; // { filename, offset } to continue from after a restart
let pendingResume = null; // resume point for the first track of the current launch
let pendingJump = null; // { filename, timestampIndex } while a timestamp jump is being applied
let currentVideoFilename = null;
let skippedVideos = [];
let titleByFilename = new Map();
let liveCheckTimer = null;
let twitchHealth = { live: null, reachable: null, checkedAt: null };
const logBuffer = [];
let sessionLogLines = [];

const isRunning = () => streamer !== null;

function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  sessionLogLines.push(line);
  // A misbehaving ffmpeg can warn many times per second for days: keep the start (cause)
  // and the end (latest state) of the session and drop lines from the middle.
  if (sessionLogLines.length > SESSION_LOG_MAX_LINES) {
    sessionLogLines.splice(
      SESSION_LOG_KEEP_HEAD,
      5_000,
      '[... log lines omitted ...]',
    );
  }
}

// Restarts create one log file per ffmpeg run; keep only the newest ones.
function pruneLogFiles() {
  try {
    const files = fs
      .readdirSync(LOGS_DIR)
      .filter((name) => /^stream-.*\.txt$/.test(name))
      .sort()
      .reverse();
    for (const name of files.slice(MAX_LOG_FILES)) {
      fs.rmSync(path.join(LOGS_DIR, name), { force: true });
    }
  } catch {}
}

// Dumps the full ffmpeg log of the just-ended session to a timestamped .txt file.
function writeSessionLogFile(reason) {
  if (sessionLogLines.length === 0) return;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const now = new Date().toISOString();
    const filePath = path.join(
      LOGS_DIR,
      `stream-${now.replace(/[:.]/g, '-')}.txt`,
    );
    const header = `ffmpeg stopped (${reason}) at ${now}\n\n`;
    fs.writeFileSync(filePath, header + sessionLogLines.join('\n') + '\n');
    pruneLogFiles();
  } catch (err) {
    console.error('Failed to write ffmpeg session log:', err.message);
  } finally {
    sessionLogLines = [];
  }
}

function writePidFile(pid) {
  try {
    fs.writeFileSync(FFMPEG_PID_FILE, String(pid));
  } catch {}
}

function removePidFile() {
  try {
    fs.rmSync(FFMPEG_PID_FILE, { force: true });
  } catch {}
}

// ffmpeg is a child of this server but keeps publishing if the server dies. Stop it on
// shutdown, and remove a leftover one (hard crash, dev restart) when the server starts.
function killLeftoverFfmpeg() {
  let pid;
  try {
    pid = Number(fs.readFileSync(FFMPEG_PID_FILE, 'utf8'));
    fs.rmSync(FFMPEG_PID_FILE, { force: true });
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
    const isFfmpeg =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
            .toString()
            .toLowerCase()
            .includes('ffmpeg')
        : fs.readFileSync(`/proc/${pid}/comm`, 'utf8').includes('ffmpeg');
    if (isFfmpeg) process.kill(pid, 'SIGKILL');
  } catch {}
}

function killFfmpegNow() {
  try {
    streamer?.forceKill();
  } catch {}
  removePidFile();
}

killLeftoverFfmpeg();
process.on('exit', killFfmpegNow);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  try {
    process.once(signal, () => {
      killFfmpegNow();
      process.kill(process.pid, signal); // continue with the default shutdown
    });
  } catch {}
}

function withoutEmptyValues(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function ffprobePath() {
  const match = /ffmpeg(\.exe)?$/i.exec(config.FFMPEG_PATH);
  if (!match) return 'ffprobe';
  return config.FFMPEG_PATH.slice(0, match.index) + `ffprobe${match[1] ?? ''}`;
}

function buildPlaylistEntries() {
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

  return entries;
}

// Videos whose file is gone are reported as skipped instead of stopping the stream.
function splitPlayable(entries) {
  titleByFilename = new Map(
    entries.map((e) => [e.filename, e.title || e.filename]),
  );
  const playable = [];
  const missing = [];
  for (const entry of entries) {
    const title = entry.title || entry.filename;
    const filePath = path.resolve(VIDEOS_DIR, entry.filename);
    if (fs.existsSync(filePath)) {
      playable.push({ filename: entry.filename, title, filePath });
    } else {
      missing.push({ filename: entry.filename, title, reason: 'file missing' });
    }
  }
  return { playable, missing };
}

function launchEngine(options, resumeFrom) {
  const { playable, missing } = splitPlayable(buildPlaylistEntries());
  skippedVideos = missing;
  if (playable.length === 0) {
    throw new Error(
      'No playable video in the playlist: all of them are missing from the videos folder. Re-upload or re-import them.',
    );
  }

  const resumeIndex = resumeFrom
    ? playable.findIndex((entry) => entry.filename === resumeFrom.filename)
    : -1;
  const resumeOffset =
    resumeIndex >= 0 ? Math.max(0, Number(resumeFrom.offset) || 0) : 0;
  pendingResume =
    resumeIndex >= 0
      ? { filename: resumeFrom.filename, startAt: resumeOffset }
      : null;

  const engineOptions = withoutEmptyValues({
    ffmpegPath: config.FFMPEG_PATH,
    ffprobePath: ffprobePath(),
    ingestUrl: options.twitchServer,
    streamKey: options.streamKey,
    playlist: playable.map((entry) => entry.filePath),
    loop: options.loop,
    fps: options.streamFps,
    preset: options.encoderPreset,
    videoBitrateKbps: options.videoBitrateKbps,
    audioBitrateKbps: options.audioBitrateKbps,
    resumeAt:
      resumeIndex >= 0
        ? { index: resumeIndex, startAt: resumeOffset }
        : null,
  });

  const engine = new TwitchStreamer(engineOptions);
  streamer = engine;
  bindEngineEvents(engine, options);
  startedAt = new Date().toISOString();
  pushLog(`Starting stream with ${playable.length} item(s)`);
  if (missing.length > 0) {
    pushLog(`Skipping ${missing.length} missing video(s).`);
  }
  try {
    engine.start();
  } catch (err) {
    streamer = null;
    throw err;
  }
  startLiveCheck();
  armScheduledRestart(options);
}

function bindEngineEvents(engine, options) {
  // Events from an engine that was already replaced or stopped are ignored.
  const on = (event, handler) =>
    engine.on(event, (...args) => {
      if (streamer === engine) handler(...args);
    });

  on('connected', () => {
    if (engine.pusher?.pid) writePidFile(engine.pusher.pid);
    pushLog('Connected to the Twitch ingest.');
  });
  on('disconnected', () => pushLog('RTMP connection lost; reconnecting.'));
  on('reconnecting', ({ attempt, delayMs }) =>
    pushLog(
      `Reconnecting to Twitch (attempt ${attempt}) in ${Math.round(delayMs / 1000)}s.`,
    ),
  );
  on('placeholder-start', () => pushLog('No video data; placeholder shown.'));
  on('placeholder-end', () => pushLog('Video data resumed; placeholder removed.'));
  on('track-start', ({ file, startAt }) => {
    const filename = path.basename(file);
    // Continuing the same video mid-way (restart or pause/resume) keeps the Twitch
    // metadata already set instead of announcing the video again.
    const resumed =
      pendingResume?.filename === filename ||
      (startAt > 0 && currentVideoFilename === filename);
    pendingResume = null;
    const jumpTo =
      pendingJump?.filename === filename ? pendingJump.timestampIndex : null;
    pendingJump = null;
    currentVideoFilename = filename;
    resumeState = { filename, offset: startAt };
    pushLog(
      `Playing ${filename}${startAt > 0 ? ` from ${Math.round(startAt)}s` : ''}`,
    );
    streamEvents.emit('videoChanged', filename, {
      resumed: resumed || jumpTo !== null,
      offset: resumed || jumpTo !== null ? startAt : 0,
      jumpTo,
    });
  });
  on('track-end', ({ file, skipped, reason }) => {
    const filename = path.basename(file);
    pushLog(skipped ? `Skipped ${filename} (${reason})` : `Finished ${filename}`);
  });
  on('track-error', ({ file, error }) => {
    const filename = path.basename(file);
    pushLog(`Could not play ${filename}: ${error}`);
    if (!skippedVideos.some((video) => video.filename === filename)) {
      skippedVideos = [
        ...skippedVideos,
        {
          filename,
          title: titleByFilename.get(filename) || filename,
          reason: error,
        },
      ];
    }
  });
  on('dropped', ({ totalBytes }) =>
    pushLog(
      `Dropped ${(totalBytes / 1048576).toFixed(1)} MB of backlog to keep up with real time.`,
    ),
  );
  on('warning', (message) => pushLog(`Warning: ${message}`));
  on('log', ({ source, line }) => {
    if (!PACKET_NOISE_RE.test(line)) pushLog(`[${source}] ${line}`);
  });
  on('playlist-empty', () => {
    if (options.loop) return;
    pushLog('Playlist finished; stopping the stream.');
    endStream('playlist-finished');
  });
}

// Ends the stream intentionally (user stop or finished playlist without loop).
function endStream(reason) {
  activeStreamConfig = null;
  startGeneration++; // cancels a start or relaunch that is still pending
  clearRelaunchTimer();
  clearScheduledRestartTimer();
  stopLiveCheck();
  resumeState = null;
  pendingResume = null;
  pendingJump = null;
  scheduledRestartPending = false;
  currentVideoFilename = null;
  startedAt = null;
  streamEvents.emit('streamStopped');
  return stopEngine(reason);
}

function stopEngine(reason) {
  const engine = streamer;
  if (!engine) return shutdownPromise ?? Promise.resolve();
  streamer = null;
  pushLog(`Stopping ffmpeg (${reason}).`);
  const shutdown = (async () => {
    try {
      await engine.stop();
    } catch (err) {
      pushLog(`Stop failed: ${err.message}`);
    }
    engine.forceKill();
    pushLog('ffmpeg stopped.');
    writeSessionLogFile(reason);
    removePidFile();
  })().finally(() => {
    if (shutdownPromise === shutdown) shutdownPromise = null;
  });
  shutdownPromise = shutdown;
  return shutdown;
}

function currentResumePoint() {
  const status = streamer?.getStatus();
  if (!status?.currentFile) return resumeState;
  return {
    filename: path.basename(status.currentFile),
    offset: Math.max(0, Number(status.position) || 0),
  };
}

function restartStream(reason, delayMs) {
  resumeState = currentResumePoint();
  stopEngine(reason);
  scheduleRelaunch(delayMs);
}

function clearRelaunchTimer() {
  if (relaunchTimer) clearTimeout(relaunchTimer);
  relaunchTimer = null;
}

function clearScheduledRestartTimer() {
  if (scheduledRestartTimer) clearTimeout(scheduledRestartTimer);
  scheduledRestartTimer = null;
  scheduledRestartAt = null;
}

function scheduleRelaunch(delayMs) {
  clearRelaunchTimer();
  const generation = startGeneration;
  relaunchTimer = setTimeout(() => {
    relaunchTimer = null;
    relaunch(generation);
  }, delayMs);
}

async function relaunch(generation) {
  await shutdownPromise;
  if (generation !== startGeneration || !activeStreamConfig || streamer) return;
  try {
    launchEngine(activeStreamConfig, resumeState);
    if (scheduledRestartPending) {
      scheduledRestartPending = false;
      streamEvents.emit('scheduledRestartCompleted');
    }
  } catch (err) {
    pushLog(`Restart failed: ${err.message} Retrying in ${RELAUNCH_RETRY_SECS}s.`);
    scheduleRelaunch(RELAUNCH_RETRY_SECS * 1000);
  }
}

function armScheduledRestart(options) {
  clearScheduledRestartTimer();
  // 0 or a missing interval disables the scheduled restart.
  if (!(options.restartIntervalSeconds > 0)) return;
  scheduledRestartAt = new Date(
    Date.now() + options.restartIntervalSeconds * 1000,
  ).toISOString();
  scheduledRestartTimer = setTimeout(() => {
    scheduledRestartTimer = null;
    scheduledRestartAt = null;
    if (!streamer || activeStreamConfig !== options) return;
    lastScheduledRestartMs = Date.now();
    scheduledRestartPending = true;
    pushLog(
      'Scheduled restart reached; stopping ffmpeg at the current video position.',
    );
    streamEvents.emit('scheduledRestart', {
      delaySeconds: options.restartDelaySeconds,
    });
    restartStream('scheduled-restart', options.restartDelaySeconds * 1000);
  }, options.restartIntervalSeconds * 1000);
}

function stopLiveCheck() {
  if (liveCheckTimer) clearInterval(liveCheckTimer);
  liveCheckTimer = null;
  twitchHealth = { live: null, reachable: null, checkedAt: null };
}

function startLiveCheck() {
  stopLiveCheck();
  const check = () =>
    getStreamLiveStatus()
      .then(({ live, reachable }) => {
        if (!streamer) return;
        twitchHealth = {
          live,
          reachable,
          checkedAt: new Date().toISOString(),
        };
      })
      .catch((err) => console.error('Twitch live check failed:', err.message));
  check();
  liveCheckTimer = setInterval(check, LIVE_CHECK_INTERVAL_MS);
}

function getCurrentSegment() {
  if (!streamer || !currentVideoFilename) return null;
  const position = streamer.getStatus().position;
  if (position == null) return null;
  const segment = getSegmentAt(readTranscript(currentVideoFilename), position);
  return segment ? { ...segment, positionSecs: position } : null;
}

export function listVideoFiles() {
  if (!fs.existsSync(VIDEOS_DIR)) return [];
  return fs
    .readdirSync(VIDEOS_DIR)
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

export function getStatus() {
  const running = isRunning();
  const sinceStart = startedAt ? Date.now() - Date.parse(startedAt) : 0;
  const lastWriteAt = running ? streamer.lastWriteAt : 0;
  const stalled =
    running &&
    sinceStart > STALL_AFTER_MS &&
    lastWriteAt > 0 &&
    Date.now() - lastWriteAt > STALL_AFTER_MS;
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
    reconnecting: !running && Boolean(relaunchTimer),
    health,
    twitchCheckedAt: twitchHealth.checkedAt,
    startedAt,
    paused: running ? Boolean(streamer.getStatus().paused) : false,
    pid: streamer?.pusher?.pid ?? null,
    scheduledRestartAt,
    log: logBuffer.slice(-50),
    videoCount: listVideoFiles().length,
    currentVideo: running ? currentVideoFilename || null : null,
    currentSegment: running ? getCurrentSegment() : null,
    skippedVideos,
  };
}

export function refreshActivePlaylist() {
  if (!streamer) return false;
  let entries;
  try {
    entries = buildPlaylistEntries();
  } catch (err) {
    pushLog(`Playlist change not applied: ${err.message}`);
    return false;
  }
  const { playable, missing } = splitPlayable(entries);
  if (playable.length === 0) {
    pushLog('Playlist change not applied: no playable video.');
    return false;
  }

  const current = streamer.getStatus();
  const currentName = current.currentFile
    ? path.basename(current.currentFile)
    : null;
  const currentIndex = playable.findIndex(
    (entry) => entry.filename === currentName,
  );
  const startIndex =
    currentIndex >= 0
      ? currentIndex + 1
      : Math.min(current.nextIndex, playable.length);

  skippedVideos = missing;
  streamer.setPlaylist(
    playable.map((entry) => entry.filePath),
    { startIndex },
  );
  // setPlaylist drops the saved position, which a paused stream needs to continue from.
  if (current.paused && currentIndex >= 0 && current.position != null) {
    streamer.seek(current.position);
  }
  pushLog(`Playlist updated: ${playable.length} item(s).`);
  return true;
}

// Transport controls for the running stream. Each returns the fresh status; they
// throw when no stream is running so the API can report a clear error.
function requireRunningEngine() {
  if (!isRunning()) throw new Error('Es läuft kein Stream.');
  return streamer;
}

export function skipTrack() {
  requireRunningEngine().skip();
  return getStatus();
}

export function previousTrack() {
  requireRunningEngine().previous();
  return getStatus();
}

export function pauseStream() {
  requireRunningEngine().pause();
  return getStatus();
}

export function resumeStream() {
  requireRunningEngine().resume();
  return getStatus();
}

// True while `filename` is the video currently on air; used to protect it from deletion.
export function isCurrentVideo(filename) {
  return isRunning() && currentVideoFilename === filename;
}

// Jumps to the next transcript timestamp of the running video (the one after the
// current playback position).
export function nextTimestamp() {
  const engine = requireRunningEngine();
  const position = engine.getStatus().position;
  if (!currentVideoFilename || position == null)
    throw new Error('Es läuft gerade kein Video.');
  const timestamps = readTranscript(currentVideoFilename)?.timestamps;
  const next = (Array.isArray(timestamps) ? timestamps : [])
    .map((ts, index) => ({ index, secs: parseTimestamp(ts?.time) }))
    .filter((ts) => ts.secs > position + 1)
    .sort((a, b) => a.secs - b.secs)[0];
  if (!next) throw new Error('Kein weiterer Zeitstempel in diesem Video.');

  pendingJump = {
    filename: currentVideoFilename,
    timestampIndex: next.index,
  };
  if (!engine.seek(next.secs)) {
    pendingJump = null;
    throw new Error('Sprung zum nächsten Zeitstempel nicht möglich.');
  }
  pushLog(`Jumping to the next timestamp at ${Math.round(next.secs)}s.`);
  return getStatus();
}

export async function startStream(options) {
  if (isRunning())
    throw new Error(
      'A stream is already running. Stop it before starting a new one.',
    );
  if (startingStream)
    throw new Error('A stream start is already in progress.');
  startingStream = true;
  try {
    return await startStreamUnlocked(options);
  } finally {
    startingStream = false;
  }
}

async function startStreamUnlocked({
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
  if (!streamKey) throw new Error('No Twitch stream key configured.');
  startGeneration++;
  const generation = startGeneration;
  clearRelaunchTimer();
  clearScheduledRestartTimer();
  await shutdownPromise;
  if (generation !== startGeneration) return getStatus();
  if (isRunning())
    throw new Error(
      'A stream is already running. Stop it before starting a new one.',
    );

  const config = {
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
  resumeState = resumeFrom;
  launchEngine(config, resumeFrom);
  activeStreamConfig = config;
  return getStatus();
}

export function stopStream() {
  endStream('stopped');
  return getStatus();
}

const OFFLINE_RESTART_DELAY_MS = 0;

// Called on EventSub stream.offline. Restarts the stream at the last video position
// unless the stop was intentional (frontend stop) or part of a scheduled restart.
export function handleStreamOffline() {
  if (!activeStreamConfig) return { restarted: false, reason: 'not-streaming' };
  const ignoreMs =
    OFFLINE_IGNORE_AFTER_SCHEDULED_RESTART_MS +
    activeStreamConfig.restartDelaySeconds * 1000;
  if (Date.now() - lastScheduledRestartMs < ignoreMs)
    return { restarted: false, reason: 'scheduled-restart' };
  if (relaunchTimer) return { restarted: false, reason: 'reconnect-pending' };
  if (shutdownPromise) return { restarted: false, reason: 'restart-pending' };

  if (isRunning()) {
    pushLog(
      'Twitch reported the stream offline; restarting ffmpeg at the current video position.',
    );
    restartStream('offline', OFFLINE_RESTART_DELAY_MS);
    return { restarted: true };
  }

  // ffmpeg is gone and no relaunch is scheduled (e.g. the last relaunch failed).
  pushLog('Twitch reported the stream offline; restarting from resume point.');
  scheduleRelaunch(OFFLINE_RESTART_DELAY_MS);
  return { restarted: true };
}

export function getLogFilePath(filename) {
  return getLogFileInfo(filename)?.filePath ?? null;
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
