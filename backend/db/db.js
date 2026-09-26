import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config from '../config.js';
import { runMigrations } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let db;

// Opens the SQLite Database and runs migrations to secure table schemas are up to date
async function openDatabase() {
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  await runMigrations(db);

  return db;
}

// --- Settings ---

export function getSettings() {
  const row = db
    .prepare(
      'SELECT twitch_server, stream_key, playlist_source, alt_streamer, loop_playlist, video_bitrate_kbps, audio_bitrate_kbps, stream_fps, restart_interval_seconds, restart_delay_seconds, chat_messages_enabled, chat_messages, updated_at FROM settings WHERE id = 1',
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
    chatMessagesEnabled: row.chat_messages_enabled === 1,
    chatMessages: JSON.parse(row.chat_messages),
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
  chatMessagesEnabled,
  chatMessages,
} = {}) {
  const cur = getSettings();
  db.prepare(
    `UPDATE settings SET twitch_server = ?, stream_key = ?, playlist_source = ?, alt_streamer = ?, loop_playlist = ?, video_bitrate_kbps = ?, audio_bitrate_kbps = ?, stream_fps = ?, restart_interval_seconds = ?, restart_delay_seconds = ?, chat_messages_enabled = ?, chat_messages = ?, updated_at = datetime('now') WHERE id = 1`,
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
    chatMessagesEnabled !== undefined
      ? chatMessagesEnabled
        ? 1
        : 0
      : cur.chatMessagesEnabled
        ? 1
        : 0,
    JSON.stringify(chatMessages ?? cur.chatMessages),
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
      "SELECT id, twitch_user_id, login, display_name, broadcaster_type, profile_image_url, role, created_at FROM users WHERE role IN ('manager', 'admin') ORDER BY display_name COLLATE NOCASE",
    )
    .all();
}

export function addManager({
  twitchUserId,
  login,
  displayName,
  broadcasterType,
  profileImageUrl,
  role = 'manager',
}) {
  const safeRole = role === 'admin' ? 'admin' : 'manager';
  const result = db
    .prepare(
      `
    INSERT INTO users (twitch_user_id, login, display_name, access_token, broadcaster_type, profile_image_url, managers, role)
    VALUES (?, ?, ?, '', ?, ?, '[]', ?)
  `,
    )
    .run(
      twitchUserId,
      login,
      displayName,
      broadcasterType ?? null,
      profileImageUrl ?? null,
      safeRole,
    );
  return db
    .prepare(
      'SELECT id, twitch_user_id, login, display_name, broadcaster_type, profile_image_url, role, created_at FROM users WHERE id = ?',
    )
    .get(result.lastInsertRowid);
}

export function removeManager(id) {
  return (
    db
      .prepare(
        "DELETE FROM users WHERE id = ? AND role IN ('manager', 'admin')",
      )
      .run(id).changes > 0
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
  return (
    db
      .prepare(
        "SELECT * FROM users WHERE role = 'broadcaster' ORDER BY updated_at DESC LIMIT 1",
      )
      .get() ?? null
  );
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

export { db, openDatabase };
