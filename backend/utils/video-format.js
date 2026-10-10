import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import config from '../config.js';
import { renameWithRetry } from './fs-retry.js';

const FFMPEG_PATH = config.FFMPEG_PATH;
const FFPROBE_PATH = FFMPEG_PATH.replace(
  /ffmpeg(\.exe)?$/i,
  (_, ext) => `ffprobe${ext ?? ''}`,
);

// The streaming pipeline joins all videos with ffmpeg's concat demuxer, which takes the
// stream parameters (codec, time base) of the FIRST file and applies them to every
// following one. Files that differ - e.g. a clip with a 1/15360 video time base followed by
// a VOD with 1/90000 - then get wrong timestamps (video drops/freezes) or are decoded
// with the wrong codec. Every stored video therefore uses one common format.
export const VIDEO_TIME_BASE = '1/90000';
export const VIDEO_TIMESCALE = 90000;
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;

export function probeStreams(file) {
  return new Promise((resolve) => {
    execFile(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,pix_fmt,time_base,sample_rate,channels,width,height',
        '-of',
        'json',
        file,
      ],
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout).streams ?? []);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// Returns why the streams deviate from the common format (empty = nothing to do).
export function getFormatIssues(streams) {
  const video = streams?.find((s) => s.codec_type === 'video');
  if (!video) return ['no video track'];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const issues = [];
  if (video.codec_name !== 'h264') issues.push(`video codec ${video.codec_name}`);
  if (video.pix_fmt !== 'yuv420p') issues.push(`pixel format ${video.pix_fmt}`);
  if (video.time_base !== VIDEO_TIME_BASE)
    issues.push(`video time base ${video.time_base}`);
  // Every video needs an audio track (silence is added when converting): the concat
  // demuxer takes the stream layout of the first file, so a silent video would mute the
  // whole stream or shift the audio of the videos after it.
  if (!audio) issues.push('no audio track');
  else {
    if (audio.codec_name !== 'aac') issues.push(`audio codec ${audio.codec_name}`);
    if (Number(audio.sample_rate) !== AUDIO_SAMPLE_RATE)
      issues.push(`audio sample rate ${audio.sample_rate}`);
    if (Number(audio.channels) !== AUDIO_CHANNELS)
      issues.push(`audio channels ${audio.channels}`);
  }
  return issues;
}

// Plain-language explanation (German, shown in the dashboard) of the strings returned by
// getFormatIssues: what is wrong, why that matters for the stream and what converting
// will do. `conversion.mode` is 'remux' (stream copy, seconds, no quality loss),
// 'reencode' (video is re-encoded, takes a while) or 'impossible'.
export function explainFormatIssues(issues) {
  const problems = issues.map((issue) => {
    const [, value = ''] = issue.match(/^[a-z ]+? ([^ ]+)$/i) ?? [];
    if (issue === 'no video track')
      return {
        issue,
        reason: 'Die Datei enthält keine Bildspur und kann nicht gestreamt werden.',
        fix: 'Nicht umwandelbar – bitte durch ein gültiges Video ersetzen.',
        reencode: false,
        impossible: true,
      };
    if (issue === 'file missing or unreadable')
      return {
        issue,
        reason: 'Die Datei fehlt oder ist nicht lesbar.',
        fix: 'Das Video neu hochladen oder den Eintrag aus der Playlist entfernen.',
        reencode: false,
        impossible: true,
      };
    if (issue === 'no duration')
      return {
        issue,
        reason: 'Die Videodauer ist nicht lesbar, die Datei ist vermutlich beschädigt.',
        fix: 'Nicht umwandelbar – bitte neu hochladen oder neu importieren.',
        reencode: false,
        impossible: true,
      };
    if (issue.startsWith('video codec'))
      return {
        issue,
        reason: `Das Bild ist als ${value.toUpperCase()} kodiert, der Stream braucht H.264. ffmpeg kann das Video nicht hinter einem anderen Codec abspielen: das Bild friert ein oder der Stream hängt.`,
        fix: 'Das Video wird neu encodiert (H.264). Das dauert je nach Länge einige Minuten, der Qualitätsverlust ist minimal.',
        reencode: true,
      };
    if (issue.startsWith('pixel format'))
      return {
        issue,
        reason: `Das Pixelformat ist ${value} statt yuv420p (z. B. 10-Bit-Video). Twitch und die Wiedergabe in der Playlist erwarten 8-Bit yuv420p.`,
        fix: 'Das Video wird neu encodiert (yuv420p). Das dauert je nach Länge einige Minuten.',
        reencode: true,
      };
    if (issue.startsWith('video time base'))
      return {
        issue,
        reason: `Die interne Zeitbasis des Videos (${value}) weicht vom Standard (${VIDEO_TIME_BASE}) ab. ffmpeg übernimmt sie vom ersten Video der Playlist; bei abweichenden Videos stimmen die Zeitstempel nicht mehr und das Bild friert ein.`,
        fix: 'Das Video wird nur umgepackt – ohne Qualitätsverlust, meist in wenigen Sekunden.',
        reencode: false,
      };
    if (issue === 'no audio track')
      return {
        issue,
        reason:
          'Das Video hat keinen Ton. Der Stream übernimmt den Aufbau vom ersten Video: ein stummes Video würde den ganzen Stream stumm schalten oder den Ton der folgenden Videos verschieben.',
        fix: 'Es wird eine stille Tonspur ergänzt. Das Bild bleibt unverändert, es dauert nur Sekunden.',
        reencode: false,
      };
    if (issue.startsWith('audio codec'))
      return {
        issue,
        reason: `Der Ton ist als ${value.toUpperCase()} kodiert, der Stream braucht AAC.`,
        fix: 'Der Ton wird neu encodiert (AAC). Das Bild bleibt unverändert.',
        reencode: false,
      };
    if (issue.startsWith('audio sample rate'))
      return {
        issue,
        reason: `Der Ton hat ${value} Hz statt ${AUDIO_SAMPLE_RATE} Hz. Abweichende Abtastraten verschieben den Ton nach einem Videowechsel.`,
        fix: 'Der Ton wird neu encodiert (48 kHz). Das Bild bleibt unverändert.',
        reencode: false,
      };
    if (issue.startsWith('audio channels'))
      return {
        issue,
        reason: `Der Ton hat ${value} Kanal/Kanäle statt ${AUDIO_CHANNELS} (Stereo).`,
        fix: 'Der Ton wird neu encodiert (Stereo). Das Bild bleibt unverändert.',
        reencode: false,
      };
    return { issue, reason: issue, fix: '', reencode: false };
  });
  const mode = problems.some((p) => p.impossible)
    ? 'impossible'
    : problems.some((p) => p.reencode)
      ? 'reencode'
      : 'remux';
  return { problems, conversion: { mode } };
}

// ffmpeg input that provides silence; paired with `-shortest` it gives silent videos an
// audio track exactly as long as the video.
export const SILENT_AUDIO_INPUT = [
  '-f',
  'lavfi',
  '-i',
  `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
];

function buildArgs(streams, source, target) {
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const copyVideo = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p';
  const copyAudio =
    audio &&
    audio.codec_name === 'aac' &&
    Number(audio.sample_rate) === AUDIO_SAMPLE_RATE &&
    Number(audio.channels) === AUDIO_CHANNELS;
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    '-i',
    source,
    ...(audio ? [] : SILENT_AUDIO_INPUT),
    '-map',
    '0:v:0',
    '-map',
    audio ? '0:a:0' : '1:a:0',
    ...(audio ? [] : ['-shortest']),
    ...(copyVideo
      ? ['-c:v', 'copy']
      : [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '22',
          '-maxrate',
          '12M',
          '-bufsize',
          '24M',
          '-pix_fmt',
          'yuv420p',
        ]),
    ...(copyAudio
      ? ['-c:a', 'copy']
      : [
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          String(AUDIO_SAMPLE_RATE),
          '-ac',
          String(AUDIO_CHANNELS),
        ]),
    '-video_track_timescale',
    String(VIDEO_TIMESCALE),
    '-movflags',
    '+faststart',
    target,
  ];
}

// Checks `file` and, only when needed, rewrites it in the common format (stream copy
// where possible, re-encode otherwise) and replaces the original by the result. The
// original is left untouched when anything fails. `onProcess` receives the running
// ffmpeg process so callers can cancel it; `stagingDir` keeps the temporary output out
// of the file's own directory; `beforeReplace` runs right before the original is replaced
// (e.g. to close open preview streams).
export async function normalizeVideoFile(
  file,
  { onProcess, stagingDir, beforeReplace } = {},
) {
  const streams = await probeStreams(file);
  const issues = getFormatIssues(streams);
  // A file without any video track can't be converted into something streamable.
  if (issues.length === 0 || !streams?.some((s) => s.codec_type === 'video'))
    return { changed: false, issues };

  if (stagingDir) fs.mkdirSync(stagingDir, { recursive: true });
  const target = stagingDir
    ? path.join(stagingDir, `${path.basename(file)}.normalized.mp4`)
    : `${file}.normalized.mp4`;
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn(FFMPEG_PATH, buildArgs(streams, file, target), {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      ff.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      onProcess?.(ff);
      ff.on('error', reject);
      ff.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)),
      );
    });
    beforeReplace?.();
    await renameWithRetry(target, file);
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }
  return { changed: true, issues };
}
