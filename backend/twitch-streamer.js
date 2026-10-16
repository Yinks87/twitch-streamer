'use strict';

/**
 * TwitchStreamer – streamt eine Playlist aus Videodateien per ffmpeg zu Twitch und hält den Stream
 * IMMER am Laufen (Platzhalter bei Lücken/hängenden Dateien, Reconnect bei Verbindungsabbruch).
 *
 *  Datei-Encoder (1 Prozess pro Datei) ─┐
 *                                       ├─► TsSwitcher (Node) ──► Pusher-ffmpeg (-c copy) ──RTMP──► Twitch
 *  Platzhalter-Encoder (bei Bedarf)  ───┘     │
 *                                             └─ schreibt PTS/DTS/PCR/Continuity-Counter um → EINE durchgehende Timeline
 *
 * - Alle Encoder nutzen identische Einstellungen (x264 veryfast, 1080p60, 6000k CBR, 2s-GOP, AAC 128k, Rec.709).
 * - Der Switcher schaltet nur an Keyframes um, daher sauberer Übergang Datei <-> Platzhalter <-> Datei.
 * - Der Pusher ist EIN langlebiger Prozess; bei Abbruch wird er neu gestartet und startet mit dem letzten GOP.
 *
 * ES-Modul (import/export): benötigt "type": "module" in der package.json (oder Dateiendung .mjs).
 * Benötigt: Node.js >= 16, ffmpeg >= 5.1 (libx264), ffprobe.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ───────────────────────── MPEG-TS Helfer ─────────────────────────

const TS_PKT = 188;
const PID_PAT = 0;
const PID_PMT = 4096;
const PID_VIDEO = 256; // Encoder-Ausgabe hat feste PIDs (-mpegts_start_pid 256, Video zuerst gemappt)
const PID_AUDIO = 257;
const WRAP = 2 ** 33;
const EMPTY = Buffer.alloc(0);
const MAX_GOP_BYTES = 12 * 1024 * 1024;

const mod33 = (v) => ((v % WRAP) + WRAP) % WRAP;

function readTs(b, o) {
  return ((b[o] >> 1) & 7) * 1073741824 + b[o + 1] * 4194304 + (b[o + 2] >> 1) * 32768 + b[o + 3] * 128 + (b[o + 4] >> 1);
}

function writeTs(b, o, v) {
  v = mod33(v);
  const hi = Math.floor(v / 1073741824);
  const lo = v - hi * 1073741824;
  b[o] = (b[o] & 0xf0) | ((hi & 7) << 1) | 1;
  b[o + 1] = (lo >>> 22) & 0xff;
  b[o + 2] = (((lo >>> 15) & 0x7f) << 1) | 1;
  b[o + 3] = (lo >>> 7) & 0xff;
  b[o + 4] = ((lo & 0x7f) << 1) | 1;
}

function readPcrBase(b) {
  return b[6] * 33554432 + b[7] * 131072 + b[8] * 512 + b[9] * 2 + (b[10] >> 7);
}

function writePcrBase(b, v) {
  v = mod33(v);
  b[6] = Math.floor(v / 33554432) & 0xff;
  b[7] = Math.floor(v / 131072) & 0xff;
  b[8] = Math.floor(v / 512) & 0xff;
  b[9] = Math.floor(v / 2) & 0xff;
  b[10] = ((v % 2) << 7) | (b[10] & 0x7f);
}

/** Random-Access-Indicator gesetzt (Keyframe-Start)? */
function isKeyPacket(p) {
  const afc = (p[3] >> 4) & 3;
  return (afc & 2) !== 0 && p[4] > 0 && (p[5] & 0x40) !== 0;
}

/** Erster PES-Zeitstempel (DTS, sonst PTS) eines PES-Start-Pakets oder null. */
function firstPesTs(p) {
  const afc = (p[3] >> 4) & 3;
  if (!(afc & 1)) return null;
  const o = afc & 2 ? 5 + p[4] : 4;
  if (o + 14 > TS_PKT || p[o] !== 0 || p[o + 1] !== 0 || p[o + 2] !== 1) return null;
  const flags = p[o + 7] >> 6;
  if (flags === 3 && o + 19 <= TS_PKT) return readTs(p, o + 14);
  if (flags & 2) return readTs(p, o + 9);
  return null;
}

/**
 * Nimmt TS-Daten mehrerer Quellen entgegen, leitet immer nur EINE aktive Quelle weiter und schreibt
 * deren Zeitstempel/Continuity-Counter so um, dass der Ausgang eine lückenlose, monotone Timeline ist.
 */
export class TsSwitcher {
  constructor({ stallMs, onBatch, onSwitch }) {
    this.stallMs = stallMs;
    this.onBatch = onBatch;
    this.onSwitch = onSwitch;
    this.active = null;
    this.offset = 0;
    this.timelineEnd = 0; // 90-kHz-Ticks, nicht gewrappt
    this.cc = new Map();
    this.lastForwardAt = Date.now();
    this.pat = null;
    this.pmt = null;
    this.gop = [];
    this.gopValid = false;
    this.gopBytes = 0;
  }

  createSource(kind) {
    return { kind, carry: EMPTY, file: null, force: false };
  }

  release(src) {
    if (this.active === src) this.active = null;
  }

  /** PAT+PMT des Ausgangs (für späten Einstieg eines Pushers). */
  psi() {
    return this.pat && this.pmt ? Buffer.concat([this.pat, this.pmt]) : EMPTY;
  }

  /** Letzter vollständiger GOP inkl. PAT/PMT – damit ein neuer Pusher sofort mit einem Keyframe startet. */
  replay() {
    if (!this.gopValid || !this.gop.length) return EMPTY;
    return Buffer.concat([this.psi(), ...this.gop]);
  }

  _canTakeOver(src) {
    if (src.force) return true; // z. B. Platzhalter bei Pause: sofort übernehmen
    const a = this.active;
    if (!a) return true;
    if (a.kind === 'filler' && src.kind === 'file') return true; // echte Datei hat Vorrang
    return Date.now() - this.lastForwardAt > this.stallMs; // aktive Quelle liefert nicht mehr
  }

  push(src, chunk) {
    const buf = src.carry.length ? Buffer.concat([src.carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % TS_PKT);
    src.carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : EMPTY;
    if (!usable) return;

    const out = Buffer.allocUnsafe(usable);
    let n = 0;
    let firstKey = -1;
    let lastKey = -1;

    for (let i = 0; i < usable; i += TS_PKT) {
      const pkt = buf.subarray(i, i + TS_PKT);
      if (pkt[0] !== 0x47) continue;
      const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];

      if (src !== this.active) {
        // Kandidat: erst bei Keyframe-Start (Video-PES) und nur wenn Umschalten erlaubt ist
        if (pid === PID_VIDEO && (pkt[1] & 0x40) && isKeyPacket(pkt) && this._canTakeOver(src)) {
          const first = firstPesTs(pkt);
          if (first === null) continue;
          this.offset = this.timelineEnd === 0 ? 0 : this.timelineEnd + 1500 - first;
          const prev = this.active;
          this.active = src;
          this.onSwitch(src, prev);
        } else {
          continue;
        }
      }

      pkt.copy(out, n);
      const o = out.subarray(n, n + TS_PKT);
      this._rewrite(o, pid);
      if (pid === PID_PAT) this.pat = Buffer.from(o);
      else if (pid === PID_PMT) this.pmt = Buffer.from(o);
      else if (pid === PID_VIDEO && (o[1] & 0x40) && isKeyPacket(o)) {
        if (firstKey < 0) firstKey = n;
        lastKey = n;
      }
      n += TS_PKT;
    }

    if (n > 0) {
      const batch = out.subarray(0, n);
      if (lastKey >= 0) {
        this.gop = [batch.subarray(lastKey)];
        this.gopBytes = n - lastKey;
        this.gopValid = true;
      } else if (this.gopValid) {
        this.gop.push(batch);
        this.gopBytes += n;
        if (this.gopBytes > MAX_GOP_BYTES) { this.gop = []; this.gopValid = false; this.gopBytes = 0; }
      }
      this.lastForwardAt = Date.now();
      this.onBatch(batch, firstKey);
    }
  }

  _rewrite(o, pid) {
    const afc = (o[3] >> 4) & 3;
    const off = this.offset;

    if ((afc & 2) && o[4] >= 7 && (o[5] & 0x10)) writePcrBase(o, readPcrBase(o) + off);

    if ((o[1] & 0x40) && (afc & 1) && (pid === PID_VIDEO || pid === PID_AUDIO)) {
      const p = afc & 2 ? 5 + o[4] : 4;
      if (p + 14 <= TS_PKT && o[p] === 0 && o[p + 1] === 0 && o[p + 2] === 1) {
        const flags = o[p + 7] >> 6;
        if (flags & 2) {
          const pts = readTs(o, p + 9) + off;
          writeTs(o, p + 9, pts);
          const end = pts + (pid === PID_VIDEO ? 1500 : 1920);
          if (end > this.timelineEnd) this.timelineEnd = end;
          if (flags === 3 && p + 19 <= TS_PKT) writeTs(o, p + 14, readTs(o, p + 14) + off);
        }
      }
    }

    // Continuity Counter lückenlos über Quellwechsel hinweg
    if (afc & 1) {
      const c = ((this.cc.has(pid) ? this.cc.get(pid) : -1) + 1) & 15;
      this.cc.set(pid, c);
      o[3] = (o[3] & 0xf0) | c;
    } else {
      o[3] = (o[3] & 0xf0) | (this.cc.get(pid) || 0);
    }
  }
}

// ───────────────────────── Streamer ─────────────────────────

const DEFAULTS = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  ingestUrl: 'rtmp://live.twitch.tv/app',
  width: 1920,
  height: 1080,
  fps: 60,
  preset: 'veryfast',
  videoBitrateKbps: 6000,
  audioBitrateKbps: 128,
  keyframeSeconds: 2,
  loop: false,
  gapMs: 0, // zusätzliche Pause zwischen Dateien
  placeholderImage: null, // Pfad zu PNG/JPG; null = schwarzes Bild
  fillerAfterMs: 1000, // so lange ohne Daten -> Platzhalter wird eingeblendet
  encoderStallMs: 8000, // Datei-Encoder liefert so lange nichts -> abbrechen, nächste Datei
  pusherStallMs: 20000, // Pusher macht trotz Daten keinen Fortschritt -> Reconnect
  maxPusherBacklogBytes: 4 * 1024 * 1024, // ~5 s Rückstau, danach wird bis zum nächsten Keyframe verworfen
  reconnect: { minDelayMs: 1000, maxDelayMs: 10000, resetAfterMs: 30000 },
};

export class TwitchStreamer extends EventEmitter {
  /**
   * Events: 'status' (connecting|live|reconnecting|stopping|stopped), 'connected', 'disconnected', 'reconnecting',
   *         'track-start' {file,startAt}, 'track-end' {file,skipped,reason,position}, 'track-error',
   *         'paused' {file,position}, 'resumed', 'placeholder-start', 'placeholder-end',
   *         'playlist-empty', 'dropped', 'log', 'warning'
   *
   * Steuerung: start(), stop(), skip(), previous(), pause(), resume(), seek(sekunden), setPlaylist(), enqueue()
   */
  constructor(opts = {}) {
    super();
    if (!opts.streamKey) throw new Error('streamKey fehlt');
    this.opts = { ...DEFAULTS, ...opts, reconnect: { ...DEFAULTS.reconnect, ...(opts.reconnect || {}) } };

    this.playlist = [...(opts.playlist || [])];
    this.index = 0;

    this.running = false;
    this._stopping = false;

    this.switcher = null;
    this.pusher = null;
    this.pusherReady = false;
    this.connected = false;
    this.lastWriteAt = 0;
    this.lastProgressAt = 0;
    this._dropUntilKey = false;

    this.filler = null;
    this._fillerRetryAt = 0;
    this._placeholderBroken = false;
    this._placeholderActive = false;

    this._cur = null; // laufender Titel { file, index, startAt, src, activeSince, activeMs, aborting }
    this._abort = null;
    this._paused = false;
    this._resume = null; // nächster Titel mit Startposition { file, index, startAt } (Pause/Seek/Previous)
    if (opts.resumeAt && this.playlist[opts.resumeAt.index]) {
      const { index, startAt = 0 } = opts.resumeAt;
      this._resume = { file: this.playlist[index], index, startAt };
    }
    this._resumeWaiter = null;
    this._itemWaiter = null;
    this._sleepers = new Set();
    this._announcedEmpty = false;
    this._lastDropEmit = 0;
    this._probeCache = new Map();

    this.stats = { droppedBytes: 0, reconnects: 0, tracksPlayed: 0, tracksFailed: 0 };
  }

  // ───────── Öffentliche API ─────────

  start() {
    if (this.running) return;
    this.running = true;
    this._stopping = false;
    this.switcher = new TsSwitcher({
      stallMs: this.opts.fillerAfterMs,
      onBatch: (buf, firstKey) => this._feed(buf, firstKey),
      onSwitch: (src, prev) => this._onSwitch(src, prev),
    });
    this._watchdogTimer = setInterval(() => this._watchdog(), 250);
    this._pusherLoopPromise = this._pusherLoop();
    this._playLoopPromise = this._playLoop();
  }

  async stop() {
    if (!this.running || this._stopping) return;
    this._stopping = true;
    this.emit('status', 'stopping');
    clearInterval(this._watchdogTimer);
    this._abortSleepers();
    this._notifyItems();
    this._notifyResume();
    if (this._abort) this._abort('stop');
    this._stopFiller();

    const p = this.pusher;
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignorieren */ }
      const t = setTimeout(() => p.kill('SIGKILL'), 3000);
      p.once('close', () => clearTimeout(t));
    }
    await Promise.all([this._playLoopPromise, this._pusherLoopPromise]);
    this.running = false;
    this.connected = false;
    this.emit('status', 'stopped');
  }

  /** Sofortiges Beenden aller Prozesse (ohne Warten), z.B. im process-exit-Hook. */
  forceKill() {
    for (const proc of [this.pusher, this.filler?.p, this._cur?.proc]) {
      try { proc?.kill('SIGKILL'); } catch (_) { /* bereits beendet */ }
    }
  }

  /** Aktuelles Video überspringen (startet das nächste; bei Pause bleibt die Pause bestehen). */
  skip() {
    let did = false;
    if (this._resume) { this.index = this._resume.index + 1; this._resume = null; did = true; }
    const c = this._cur;
    if (c && !c.aborting && this._abort) { this._abort('skip'); did = true; }
    this._notifyItems();
    return did;
  }

  /** Zum vorherigen Video springen (am Anfang der Playlist: erstes Video von vorn). */
  previous() {
    const curIdx = this._resume ? this._resume.index : this.index - 1;
    if (curIdx < 0 || curIdx >= this.playlist.length) return false;
    let prev = curIdx - 1;
    if (prev < 0) prev = this.opts.loop ? this.playlist.length - 1 : 0;
    this._resume = { file: this.playlist[prev], index: prev, startAt: 0 };
    const c = this._cur;
    if (c && !c.aborting && this._abort) this._abort('previous');
    this._notifyItems();
    return true;
  }

  /** Pausiert: Datei-Encoder wird beendet, der Platzhalter hält den Stream online. */
  pause() {
    if (!this.running || this._stopping || this._paused) return false;
    this._paused = true;
    const c = this._cur;
    if (c && !c.aborting && !this._resume) {
      this._resume = { file: c.file, index: c.index, startAt: this._position() };
    }
    if (c && !c.aborting) {
      this._startFiller({ force: true }); // Platzhalter sofort statt erst nach fillerAfterMs
      this._abort('pause');
    }
    this.emit('paused', { file: this._resume ? this._resume.file : null, position: this._resume ? this._resume.startAt : null });
    return true;
  }

  /** Setzt die Wiedergabe an der gemerkten Stelle fort. */
  resume() {
    if (!this._paused) return false;
    this._paused = false;
    this._notifyResume();
    this.emit('resumed');
    return true;
  }

  /** Springt im aktuellen (oder pausierten) Video an die Position in Sekunden. */
  seek(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return false;
    const c = this._cur;
    let target = null;
    if (this._resume) target = this._resume;
    else if (c && !c.aborting) target = { file: c.file, index: c.index };
    else if (this.index - 1 >= 0 && this.index - 1 < this.playlist.length) target = { file: this.playlist[this.index - 1], index: this.index - 1 };
    if (!target) return false;
    this._resume = { file: target.file, index: target.index, startAt: seconds };
    if (c && !c.aborting && this._abort) this._abort('seek');
    this._notifyItems();
    return true;
  }

  /** Aktuelle Abspielposition in Sekunden (null, wenn nichts läuft). */
  _position() {
    const c = this._cur;
    if (!c) return this._resume ? this._resume.startAt : null;
    let ms = c.activeMs;
    if (c.activeSince) ms += Date.now() - c.activeSince;
    return c.startAt + ms / 1000;
  }

  setPlaylist(files, { startIndex = 0, skipCurrent = false } = {}) {
    this.playlist = [...files];
    this.index = startIndex;
    this._resume = null;
    this._notifyItems();
    if (skipCurrent) this.skip();
  }

  enqueue(file) {
    this.playlist.push(file);
    this._notifyItems();
  }

  getStatus() {
    return {
      running: this.running,
      connected: this.connected,
      currentFile: this._cur ? this._cur.file : this._resume ? this._resume.file : null,
      paused: this._paused,
      position: this._position(),
      placeholderActive: this._placeholderActive,
      nextIndex: this.index,
      playlistLength: this.playlist.length,
      stats: { ...this.stats },
    };
  }

  // ───────── Watchdog / Platzhalter ─────────

  _watchdog() {
    if (this._stopping || !this.switcher) return;
    const now = Date.now();
    const sw = this.switcher;
    const starving = now - sw.lastForwardAt > this.opts.fillerAfterMs;

    if (starving && !this.filler && now >= this._fillerRetryAt) {
      this._startFiller();
    } else if (!starving && this.filler && sw.active && sw.active.kind === 'file' && now - this.filler.startedAt > 2000) {
      this._stopFiller(); // Datei läuft wieder, Platzhalter nicht mehr nötig
    }
  }

  _onSwitch(src, prev) {
    const c = this._cur;
    if (c && prev && prev === c.src && c.activeSince) { // Titel war aktiv und wurde abgelöst: Spielzeit festhalten
      c.activeMs += Date.now() - c.activeSince;
      c.activeSince = null;
    }
    if (c && src === c.src) c.activeSince = Date.now();
    if (src.kind === 'filler') {
      if (!this._placeholderActive) {
        this._placeholderActive = true;
        this.emit('placeholder-start');
      }
    } else {
      if (this._placeholderActive) {
        this._placeholderActive = false;
        this.emit('placeholder-end');
      }
      this._stopFiller();
      this.emit('track-start', { file: src.file, startAt: c && src === c.src ? c.startAt : 0 });
    }
  }

  _startFiller({ force = false } = {}) {
    if (this.filler) { if (force) this.filler.src.force = true; return; }
    const o = this.opts;
    const useImage = o.placeholderImage && !this._placeholderBroken;
    const inputs = useImage
      ? ['-loop', '1', '-framerate', String(o.fps), '-i', o.placeholderImage]
      : ['-f', 'lavfi', '-i', `color=c=black:s=${o.width}x${o.height}:r=${o.fps}`];
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');

    const args = this._encoderArgs({ inputs, vmap: '0:v:0', amap: '1:a:0', finite: false });
    const src = this.switcher.createSource('filler');
    src.force = force;
    const p = spawn(o.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const f = { p, src, startedAt: Date.now(), bytes: 0 };
    this.filler = f;

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (this.filler === f) this.filler = null;
      this.switcher.release(src);
      if (!this._stopping && f.bytes === 0) {
        if (useImage) {
          this._placeholderBroken = true;
          this.emit('warning', 'Platzhalter-Bild nicht nutzbar – verwende schwarzes Bild');
        }
        this._fillerRetryAt = Date.now() + 2000;
      }
    };
    p.stdout.on('data', (d) => { f.bytes += d.length; this.switcher.push(src, d); });
    p.stderr.on('data', (d) => this._log('filler', d.toString()));
    p.on('error', (e) => { this.emit('warning', `Platzhalter-Start fehlgeschlagen: ${e.message}`); cleanup(); });
    p.on('close', cleanup);
  }

  _stopFiller() {
    if (this.filler) this.filler.p.kill('SIGKILL');
  }

  // ───────── Pusher (Twitch-Verbindung) ─────────

  async _pusherLoop() {
    const r = this.opts.reconnect;
    let attempt = 0;
    let first = true;
    while (!this._stopping) {
      this.emit('status', first ? 'connecting' : 'reconnecting');
      const startedAt = Date.now();
      await this._runPusher();
      first = false;
      if (this._stopping) break;
      if (Date.now() - startedAt >= r.resetAfterMs) attempt = 0;
      const delay = Math.min(r.maxDelayMs, r.minDelayMs * 2 ** attempt);
      attempt++;
      this.stats.reconnects++;
      this.emit('reconnecting', { attempt, delayMs: delay });
      await this._sleep(delay);
    }
  }

  _runPusher() {
    return new Promise((resolve) => {
      const o = this.opts;
      const url = `${o.ingestUrl.replace(/\/+$/, '')}/${o.streamKey}`;
      const args = [
        '-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1',
        // KEIN -fflags +nobuffer: verschluckt die ersten Pakete und verschiebt die Zeitstempel
        '-analyzeduration', '2000000', '-probesize', '2000000',
        '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0',
        '-c', 'copy',
        '-flvflags', 'no_duration_filesize',
        '-rw_timeout', '10000000',
        '-f', 'flv', url,
      ];

      let done = false;
      let connected = false;
      const p = spawn(o.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.pusher = p;
      this.pusherReady = true;
      this._dropUntilKey = false;
      this.lastProgressAt = Date.now();

      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        if (this.pusher === p) { this.pusher = null; this.pusherReady = false; }
        if (this.connected) { this.connected = false; this.emit('disconnected'); }
        resolve();
      };

      p.stdin.on('error', () => { /* EPIPE – 'close' regelt den Rest */ });
      p.stdout.on('data', () => { this.lastProgressAt = Date.now(); });
      p.stderr.on('data', (d) => {
        const text = d.toString();
        this._log('pusher', text);
        if (!connected && /Output #0, flv/.test(text)) {
          connected = true;
          this.connected = true;
          this.emit('connected');
          this.emit('status', 'live');
        }
      });

      const watchdog = setInterval(() => {
        const now = Date.now();
        if (now - this.lastWriteAt < 5000 && now - this.lastProgressAt > o.pusherStallMs) {
          this.emit('warning', 'Pusher hängt – wird beendet, Reconnect folgt');
          p.kill('SIGKILL');
        }
      }, 2000);

      p.on('error', (e) => { this.emit('warning', `Pusher konnte nicht gestartet werden: ${e.message}`); finish(); });
      p.on('close', finish);

      // Einstieg mit dem letzten Keyframe-GOP, damit Twitch sofort ein dekodierbares Bild bekommt
      const replay = this.switcher ? this.switcher.replay() : EMPTY;
      if (replay.length) { this.lastWriteAt = Date.now(); p.stdin.write(replay); }
    });
  }

  /** Ausgang des Switchers -> Pusher. Bei Überlauf wird bis zum nächsten Keyframe verworfen (wie OBS Dropped Frames). */
  _feed(buf, firstKey) {
    const p = this.pusher;
    const drop = () => {
      this.stats.droppedBytes += buf.length;
      const now = Date.now();
      if (now - this._lastDropEmit > 5000) {
        this._lastDropEmit = now;
        this.emit('dropped', { totalBytes: this.stats.droppedBytes });
      }
    };
    if (!p || !this.pusherReady || !p.stdin.writable) return drop(); // Reconnect-Phase: Pusher bekommt später den letzten GOP

    if (this._dropUntilKey) {
      if (firstKey < 0) return drop();
      this._dropUntilKey = false;
      buf = Buffer.concat([this.switcher.psi(), buf.subarray(firstKey)]);
    } else if (p.stdin.writableLength > this.opts.maxPusherBacklogBytes) {
      this._dropUntilKey = true;
      return drop();
    }

    const now = Date.now();
    if (now - this.lastWriteAt > 3000) this.lastProgressAt = now;
    this.lastWriteAt = now;
    p.stdin.write(buf);
  }

  // ───────── Playlist / Datei-Encoder ─────────

  _peekNext() {
    if (this.index < this.playlist.length) return this.playlist[this.index];
    if (this.opts.loop && this.playlist.length) return this.playlist[0];
    return null;
  }

  _nextItem() {
    if (this.index >= this.playlist.length) {
      if (this.opts.loop && this.playlist.length) this.index = 0;
      else return null;
    }
    const index = this.index++;
    return { file: this.playlist[index], index, startAt: 0 };
  }

  async _playLoop() {
    let failures = 0;
    while (!this._stopping) {
      if (this._paused) { await this._waitForResume(); continue; }

      let item;
      if (this._resume) {
        item = this._resume;
        this._resume = null;
        this.index = item.index + 1;
      } else {
        item = this._nextItem();
      }
      if (!item) {
        if (!this._announcedEmpty) {
          this._announcedEmpty = true;
          this.emit('playlist-empty'); // Platzhalter läuft weiter, Stream bleibt online
        }
        await this._waitForItems();
        continue;
      }
      this._announcedEmpty = false;

      const result = await this._playOne(item);
      if (this._stopping) break;
      if (result.aborted) { failures = 0; continue; } // Skip/Pause/Seek/Previous: sofort weiter

      if (result.ok) failures = 0;
      else {
        failures++;
        await this._sleep(Math.min(5000, 500 * failures));
      }
      if (this.opts.gapMs) await this._sleep(this.opts.gapMs);
    }
  }

  _probe(file) {
    if (this._probeCache.has(file)) {
      const c = this._probeCache.get(file);
      this._probeCache.delete(file);
      return c;
    }
    return this._runProbe(file);
  }

  _runProbe(file) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.opts.ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
      let out = '';
      let err = '';
      const t = setTimeout(() => p.kill('SIGKILL'), 15000);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(err.trim() || `ffprobe exit ${code}`));
        const tokens = out.split(/[\s,]+/).filter(Boolean);
        const num = tokens.map(Number).find((n) => Number.isFinite(n) && n > 0);
        resolve({ hasVideo: tokens.includes('video'), hasAudio: tokens.includes('audio'), duration: num || null });
      });
    });
  }

  /** Nächste Datei vorab prüfen, damit der Dateiwechsel schneller geht. */
  _prefetchNext() {
    const next = this._peekNext();
    if (!next || this._probeCache.has(next)) return;
    const pr = this._runProbe(next);
    pr.catch(() => {});
    this._probeCache.set(next, pr);
  }

  _encoderArgs({ inputs, vmap, amap, finite }) {
    const o = this.opts;
    const gop = Math.round(o.fps * o.keyframeSeconds);
    const vb = `${o.videoBitrateKbps}k`;

    const vf = [
      'setpts=PTS-STARTPTS',
      `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease:flags=bicubic:out_color_matrix=bt709:out_range=tv`,
      `pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:black`,
      'setsar=1',
      `fps=${o.fps}`,
      'format=yuv420p',
      'realtime',
    ].join(',');

    const af = [
      'asetpts=PTS-STARTPTS',
      'aresample=48000:async=1000:first_pts=0',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      'apad',
      'arealtime',
    ].join(',');

    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', ...inputs, '-map', vmap, '-map', amap, '-filter:v', vf, '-filter:a', af];
    if (finite) args.push('-shortest');
    args.push(
      '-c:v', 'libx264', '-preset', o.preset, '-profile:v', 'high', '-level:v', '4.2',
      '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-r', String(o.fps), '-fps_mode', 'cfr',
      '-b:v', vb, '-minrate', vb, '-maxrate', vb, '-bufsize', vb,
      '-bf', '2', '-g', String(gop),
      '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0:nal-hrd=cbr:repeat-headers=1`,
      '-c:a', 'aac', '-b:a', `${o.audioBitrateKbps}k`, '-ar', '48000', '-ac', '2',
      '-f', 'mpegts',
      '-mpegts_start_pid', String(PID_VIDEO), '-mpegts_pmt_start_pid', String(PID_PMT),
      '-mpegts_flags', '+resend_headers+pat_pmt_at_frames', '-pat_period', '0.5',
      '-flush_packets', '1',
      'pipe:1'
    );
    return args;
  }

  /** Spielt einen Titel ab (optional ab startAt). Resolved immer mit { ok, aborted } – wirft nie. */
  async _playOne({ file, index, startAt = 0 }) {
    const cur = { file, index, startAt, src: null, activeSince: null, activeMs: 0, aborting: false, reason: null };
    this._cur = cur;
    let killFn = null;
    this._abort = (reason = 'skip') => {
      if (cur.aborting) return;
      cur.aborting = true;
      cur.reason = reason;
      if (killFn) killFn();
    };
    const cleanup = () => {
      if (this._cur === cur) { this._cur = null; this._abort = null; }
    };

    let info;
    try {
      info = await this._probe(file);
      if (!info.hasVideo) throw new Error('Keine Videospur gefunden');
    } catch (e) {
      cleanup();
      this.stats.tracksFailed++;
      this.emit('track-error', { file, error: e.message });
      return { ok: false };
    }
    if (cur.aborting || this._stopping) { cleanup(); return { ok: true, aborted: cur.aborting }; }
    if (startAt > 0 && info.duration && startAt >= info.duration - 0.1) { // Seek hinter das Ende = Titel beendet
      cleanup();
      this.emit('track-end', { file, skipped: false, reason: 'seek-past-end', position: startAt });
      return { ok: true };
    }

    const inputs = [];
    if (startAt > 0) inputs.push('-ss', startAt.toFixed(3)); // Eingangs-Seek; beim Transkodieren bildgenau
    inputs.push(
      '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err',
      '-analyzeduration', '10000000', '-probesize', '10000000',
      '-i', file
    );
    if (!info.hasAudio) inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    const args = this._encoderArgs({ inputs, vmap: '0:v:0', amap: info.hasAudio ? '0:a:0' : '1:a:0', finite: true });

    return new Promise((resolve) => {
      const src = this.switcher.createSource('file');
      src.file = file;
      cur.src = src;
      const p = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      cur.proc = p;
      let done = false;
      let bytes = 0;
      let lastData = Date.now();
      let errTail = '';

      killFn = () => {
        p.kill('SIGTERM');
        setTimeout(() => { if (!done) p.kill('SIGKILL'); }, 3000).unref();
      };
      this._prefetchNext();

      p.stdout.on('data', (d) => { lastData = Date.now(); bytes += d.length; this.switcher.push(src, d); });
      p.stderr.on('data', (d) => {
        errTail = (errTail + d.toString()).slice(-4000);
        this._log('encoder', d.toString());
      });

      const watchdog = setInterval(() => {
        if (Date.now() - lastData > this.opts.encoderStallMs) {
          this.emit('warning', `Datei hängt: ${file} – wird abgebrochen (Platzhalter läuft)`);
          p.kill('SIGKILL');
        }
      }, 1000);

      const finish = (ok, error) => {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        this.switcher.release(src);
        const position = this._position();
        cleanup();
        if (ok) {
          this.stats.tracksPlayed++;
          this.emit('track-end', { file, skipped: cur.aborting, reason: cur.reason, position });
        } else {
          this.stats.tracksFailed++;
          this.emit('track-error', { file, error: error || errTail.trim() });
        }
        resolve({ ok, aborted: cur.aborting });
      };

      p.on('error', (e) => finish(false, e.message));
      p.on('close', (code, signal) => {
        if (this._stopping || cur.aborting) return finish(true);
        if (code === 0 && bytes > 0) return finish(true);
        if (code === 0 && startAt > 0) return finish(true); // Seek hinter das Ende = Titel beendet
        finish(false, `ffmpeg exit ${code ?? signal}${bytes === 0 ? ' (keine Daten)' : ''}`);
      });
    });
  }

  // ───────── Hilfsfunktionen ─────────

  _waitForResume() { return new Promise((res) => { this._resumeWaiter = res; }); }

  _notifyResume() {
    if (this._resumeWaiter) { const r = this._resumeWaiter; this._resumeWaiter = null; r(); }
  }

  _waitForItems() { return new Promise((res) => { this._itemWaiter = res; }); }

  _notifyItems() {
    if (this._itemWaiter) { const r = this._itemWaiter; this._itemWaiter = null; r(); }
  }

  _sleep(ms) {
    return new Promise((res) => {
      const s = { res, t: null };
      s.t = setTimeout(() => { this._sleepers.delete(s); res(); }, ms);
      this._sleepers.add(s);
    });
  }

  _abortSleepers() {
    for (const s of this._sleepers) { clearTimeout(s.t); s.res(); }
    this._sleepers.clear();
  }

  _log(source, text) {
    const key = this.opts.streamKey;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line) this.emit('log', { source, line: line.split(key).join('***') });
    }
  }
}

export default TwitchStreamer;

/* ───────────────────────── Beispiel ─────────────────────────

import { TwitchStreamer } from './twitch-streamer.js';

const streamer = new TwitchStreamer({
  streamKey: 'live_xxxxxxxxxxxxxxxx',
  playlist: ['/videos/a.mp4', '/videos/b.mkv', '/videos/c.avi'],
  loop: true,
  placeholderImage: '/assets/gleich-gehts-weiter.png', // optional, sonst schwarzes Bild
});

streamer.on('status', (s) => console.log('[status]', s));
streamer.on('track-start', ({ file }) => console.log('Start:', file));
streamer.on('track-error', ({ file, error }) => console.warn('Fehler:', file, error));
streamer.on('placeholder-start', () => console.log('Platzhalter aktiv'));
streamer.on('placeholder-end', () => console.log('Platzhalter beendet'));
streamer.on('reconnecting', (r) => console.log('Reconnect in', r.delayMs, 'ms'));

streamer.start();
// streamer.skip();            // nächstes Video
// streamer.previous();        // vorheriges Video
// streamer.pause();           // Platzhalter, Stream bleibt online
// streamer.resume();          // an gleicher Stelle weiter
// streamer.seek(90);          // Sekunde 90 des aktuellen Videos
// streamer.enqueue('/videos/d.mp4');
// await streamer.stop();   // einziger Weg, den Stream zu beenden

*/
