import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    twitch_server   TEXT    NOT NULL DEFAULT 'rtmp://live.twitch.tv/app',
    stream_key      TEXT    NOT NULL DEFAULT '',
    playlist_source TEXT    NOT NULL DEFAULT 'all',
    alt_streamer    TEXT    NOT NULL DEFAULT '',
    loop_playlist   INTEGER NOT NULL DEFAULT 1,
    video_bitrate_kbps INTEGER NOT NULL DEFAULT 6000,
    audio_bitrate_kbps INTEGER NOT NULL DEFAULT 128,
    stream_fps      INTEGER NOT NULL DEFAULT 60,
    restart_interval_seconds INTEGER NOT NULL DEFAULT 169200,
    restart_delay_seconds INTEGER NOT NULL DEFAULT 5,
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_user_id   TEXT    UNIQUE NOT NULL,
    login            TEXT    NOT NULL,
    display_name     TEXT    NOT NULL,
    access_token     TEXT    NOT NULL,
    refresh_token    TEXT,
    token_expires_at TEXT,
      broadcaster_type TEXT,
      managers         TEXT NOT NULL DEFAULT '[]',
    profile_image_url TEXT,
    role             TEXT NOT NULL DEFAULT 'manager',
    session_token    TEXT    UNIQUE,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    position   INTEGER NOT NULL DEFAULT 0,
    source     TEXT    NOT NULL DEFAULT 'upload',
    title      TEXT    NOT NULL DEFAULT '',
    filename   TEXT    NOT NULL,
    vod_id     TEXT,
    status     TEXT    NOT NULL DEFAULT 'ready',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const settingColumns = db
  .prepare('PRAGMA table_info(settings)')
  .all()
  .map((column) => column.name);
if (!settingColumns.includes('video_bitrate_kbps'))
  db.exec(
    'ALTER TABLE settings ADD COLUMN video_bitrate_kbps INTEGER NOT NULL DEFAULT 6000',
  );
if (!settingColumns.includes('audio_bitrate_kbps'))
  db.exec(
    'ALTER TABLE settings ADD COLUMN audio_bitrate_kbps INTEGER NOT NULL DEFAULT 128',
  );
if (!settingColumns.includes('stream_fps'))
  db.exec(
    'ALTER TABLE settings ADD COLUMN stream_fps INTEGER NOT NULL DEFAULT 60',
  );
if (!settingColumns.includes('restart_interval_seconds'))
  db.exec(
    'ALTER TABLE settings ADD COLUMN restart_interval_seconds INTEGER NOT NULL DEFAULT 169200',
  );
if (!settingColumns.includes('restart_delay_seconds'))
  db.exec(
    'ALTER TABLE settings ADD COLUMN restart_delay_seconds INTEGER NOT NULL DEFAULT 5',
  );

const userColumns = db
  .prepare('PRAGMA table_info(users)')
  .all()
  .map((column) => column.name);
if (!userColumns.includes('broadcaster_type'))
  db.exec('ALTER TABLE users ADD COLUMN broadcaster_type TEXT');
if (!userColumns.includes('managers'))
  db.exec("ALTER TABLE users ADD COLUMN managers TEXT NOT NULL DEFAULT '[]'");
if (!userColumns.includes('role'))
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'manager'");
if (!userColumns.includes('profile_image_url'))
  db.exec('ALTER TABLE users ADD COLUMN profile_image_url TEXT');

const permittedUser = String(config.TWITCH_PERMITTED_USER || '')
  .trim()
  .toLowerCase();
if (permittedUser) {
  db.prepare(
    `
    UPDATE users
    SET role = 'broadcaster'
    WHERE lower(twitch_user_id) = ? OR lower(login) = ? OR lower(display_name) = ?
  `,
  ).run(permittedUser, permittedUser, permittedUser);
}

// --- Settings ---

export function getSettings() {
  const row = db
    .prepare(
      'SELECT twitch_server, stream_key, playlist_source, alt_streamer, loop_playlist, video_bitrate_kbps, audio_bitrate_kbps, stream_fps, restart_interval_seconds, restart_delay_seconds, updated_at FROM settings WHERE id = 1',
    )
    .get();
  return {
    twitchServer: row.twitch_server,
    streamKey: row.stream_key,
    playlistSource: row.playlist_source,
    altStreamer: row.alt_streamer,
    loopPlaylist: row.loop_playlist === 1,
    videoBitrateKbps: row.video_bitrate_kbps,
    audioBitrateKbps: row.audio_bitrate_kbps,
    streamFps: row.stream_fps,
    restartIntervalSeconds: row.restart_interval_seconds,
    restartDelaySeconds: row.restart_delay_seconds,
    updatedAt: row.updated_at,
  };
}

export function saveSettings({
  twitchServer,
  streamKey,
  playlistSource,
  altStreamer,
  loopPlaylist,
  videoBitrateKbps,
  audioBitrateKbps,
  streamFps,
  restartIntervalSeconds,
  restartDelaySeconds,
} = {}) {
  const cur = getSettings();
  db.prepare(
    `UPDATE settings SET twitch_server = ?, stream_key = ?, playlist_source = ?, alt_streamer = ?, loop_playlist = ?, video_bitrate_kbps = ?, audio_bitrate_kbps = ?, stream_fps = ?, restart_interval_seconds = ?, restart_delay_seconds = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(
    twitchServer ?? cur.twitchServer,
    streamKey ?? cur.streamKey,
    playlistSource ?? cur.playlistSource,
    altStreamer ?? cur.altStreamer,
    loopPlaylist !== undefined
      ? loopPlaylist
        ? 1
        : 0
      : cur.loopPlaylist
        ? 1
        : 0,
    videoBitrateKbps ?? cur.videoBitrateKbps,
    audioBitrateKbps ?? cur.audioBitrateKbps,
    streamFps ?? cur.streamFps,
    restartIntervalSeconds ?? cur.restartIntervalSeconds,
    restartDelaySeconds ?? cur.restartDelaySeconds,
  );
  return getSettings();
}

// --- Auth / Users ---

export function upsertUser({
  twitchUserId,
  login,
  displayName,
  accessToken,
  refreshToken,
  tokenExpiresAt,
  broadcasterType,
  profileImageUrl,
  role,
  managers,
  sessionToken,
}) {
  db.prepare(
    `
    INSERT INTO users (twitch_user_id, login, display_name, access_token, refresh_token, token_expires_at, broadcaster_type, profile_image_url, managers, role, session_token, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(twitch_user_id) DO UPDATE SET
      login           = excluded.login,
      display_name    = excluded.display_name,
      access_token    = excluded.access_token,
      refresh_token   = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at,
      broadcaster_type = excluded.broadcaster_type,
      profile_image_url = excluded.profile_image_url,
      managers         = users.managers,
      role             = users.role,
      session_token   = excluded.session_token,
      updated_at      = datetime('now')
  `,
  ).run(
    twitchUserId,
    login,
    displayName,
    accessToken,
    refreshToken ?? null,
    tokenExpiresAt ?? null,
    broadcasterType ?? null,
    profileImageUrl ?? null,
    managers == null
      ? '[]'
      : typeof managers === 'string'
        ? managers
        : JSON.stringify(managers),
    role ?? 'manager',
    sessionToken,
  );
  return getUserByTwitchId(twitchUserId);
}

export function getUserCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

export function getManagers() {
  return db
    .prepare(
      "SELECT id, twitch_user_id, login, display_name, broadcaster_type, profile_image_url, role, created_at FROM users WHERE role = 'manager' ORDER BY display_name COLLATE NOCASE",
    )
    .all();
}

export function addManager({
  twitchUserId,
  login,
  displayName,
  broadcasterType,
  profileImageUrl,
}) {
  const result = db
    .prepare(
      `
    INSERT INTO users (twitch_user_id, login, display_name, access_token, broadcaster_type, profile_image_url, managers, role)
    VALUES (?, ?, ?, '', ?, ?, '[]', 'manager')
  `,
    )
    .run(twitchUserId, login, displayName, broadcasterType ?? null, profileImageUrl ?? null);
  return db
    .prepare(
      'SELECT id, twitch_user_id, login, display_name, broadcaster_type, profile_image_url, role, created_at FROM users WHERE id = ?',
    )
    .get(result.lastInsertRowid);
}

export function removeManager(id) {
  return (
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'manager'").run(id)
      .changes > 0
  );
}

export function getUserBySession(sessionToken) {
  if (!sessionToken) return null;
  return (
    db
      .prepare('SELECT * FROM users WHERE session_token = ?')
      .get(sessionToken) ?? null
  );
}

export function getUserByTwitchId(twitchUserId) {
  return (
    db
      .prepare('SELECT * FROM users WHERE twitch_user_id = ?')
      .get(twitchUserId) ?? null
  );
}

export function getBroadcasterUser() {
  return db.prepare("SELECT * FROM users WHERE role = 'broadcaster' ORDER BY updated_at DESC LIMIT 1").get() ?? null;
}

export function clearSession(sessionToken) {
  db.prepare(
    'UPDATE users SET session_token = NULL WHERE session_token = ?',
  ).run(sessionToken);
}

export function getUserByAccessToken(accessToken) {
  if (!accessToken) return null;
  return (
    db.prepare('SELECT * FROM users WHERE access_token = ?').get(accessToken) ??
    null
  );
}

// --- Playlist ---

export function getPlaylist(sourceFilter) {
  if (sourceFilter && sourceFilter !== 'all') {
    return db
      .prepare(
        'SELECT * FROM playlist WHERE source = ? ORDER BY position ASC, id ASC',
      )
      .all(sourceFilter);
  }
  return db
    .prepare('SELECT * FROM playlist ORDER BY position ASC, id ASC')
    .all();
}

export function addPlaylistEntry({
  source,
  title,
  filename,
  vodId = null,
  enabled = 1,
}) {
  const { mp } = db.prepare('SELECT MAX(position) as mp FROM playlist').get();
  const position = (mp ?? -1) + 1;
  const result = db
    .prepare(
      `INSERT INTO playlist (source, title, filename, vod_id, position, status, enabled) VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
    )
    .run(source, title, filename, vodId, position, enabled ? 1 : 0);
  return db
    .prepare('SELECT * FROM playlist WHERE id = ?')
    .get(result.lastInsertRowid);
}

export function updatePlaylistEntry(id, fields) {
  const allowed = ['status', 'enabled', 'position', 'title'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;
  db.prepare(
    `UPDATE playlist SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
  ).run(...keys.map((k) => fields[k]), id);
}

export function removePlaylistEntry(id) {
  db.prepare('DELETE FROM playlist WHERE id = ?').run(id);
}

export function reorderPlaylist(orderedIds) {
  const current = getPlaylist();
  const currentIds = new Set(current.map((entry) => entry.id));
  const seen = new Set();
  const validIds = orderedIds
    .map(Number)
    .filter((id) => currentIds.has(id) && !seen.has(id) && seen.add(id));
  const missingIds = current
    .map((entry) => entry.id)
    .filter((id) => !seen.has(id));
  const normalizedIds = [...validIds, ...missingIds];
  const stmt = db.prepare('UPDATE playlist SET position = ? WHERE id = ?');
  db.transaction((ids) => ids.forEach((id, idx) => stmt.run(idx, id)))(
    normalizedIds,
  );
  return getPlaylist();
}

export function getPlaylistEntryByFilename(filename) {
  return (
    db.prepare('SELECT * FROM playlist WHERE filename = ?').get(filename) ??
    null
  );
}

export function getPlaylistEntryByVodId(vodId) {
  return (
    db.prepare('SELECT * FROM playlist WHERE vod_id = ?').get(vodId) ?? null
  );
}

// Exposed for server.js raw queries when needed.
// Returns the most-recently-active user (single-streamer app).
export function getAnyUser() {
  return (
    db.prepare('SELECT * FROM users ORDER BY updated_at DESC LIMIT 1').get() ??
    null
  );
}

export { db };
