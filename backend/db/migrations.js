import config from '../config.js';

const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    up: async (db) => {
      await db.pragma('journal_mode = WAL');
      await db.pragma('foreign_keys = ON');
      await db.pragma('busy_timeout = 5000');

      await db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          id              INTEGER PRIMARY KEY CHECK (id = 1),
          twitch_server   TEXT    NOT NULL DEFAULT 'rtmp://live.twitch.tv/app',
          stream_key      TEXT    NOT NULL DEFAULT '',
          playlist_source TEXT    NOT NULL DEFAULT 'all',
          alt_streamer    TEXT    NOT NULL DEFAULT '',
          loop_playlist   INTEGER NOT NULL DEFAULT 1,
          chat_messages_enabled   INTEGER NOT NULL DEFAULT 1,
          max_storage_gb    INTEGER NOT NULL DEFAULT 500,
          shuffle_mode       INTEGER NOT NULL DEFAULT 0,
          pin_message_enabled INTEGER NOT NULL DEFAULT 1,
          chat_messages           TEXT NOT NULL DEFAULT '{"currentVideo":"Aktueller Titel: \\"\${title}\\" in der Kategorie: \\"\${category}\\"","restartMessage":"Stream wird in \${duration}s neu gestartet", "pinMessage":"24/7 VOD Channel! Für Live Content folgt meinem Main Twitch Channel!"}',
          video_bitrate_kbps INTEGER NOT NULL DEFAULT 6000,
          audio_bitrate_kbps INTEGER NOT NULL DEFAULT 128,
          stream_fps      INTEGER NOT NULL DEFAULT 60,
          restart_interval_seconds INTEGER NOT NULL DEFAULT 169200,
          restart_delay_seconds INTEGER NOT NULL DEFAULT 30,
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
    },
  },
  {
    version: 2,
    name: 'add_shuffle_mode',
    up: (db) => {
      const settingColumns = db
        .prepare('PRAGMA table_info(settings)') // Get the table info for the settings table
        .all()
        .map((column) => column.name);
      if (!settingColumns.includes('shuffle_mode')) // Add the max_storage_gb column if it doesn't exist
        db.exec(
          'ALTER TABLE settings ADD COLUMN shuffle_mode INTEGER NOT NULL DEFAULT 0',
        );
    },
  },

  // Example of a future migration:
  // {
  //   version: 2,
  //   name: 'release_name',
  //   up: (db) => {
  //     const settingColumns = db
  //       .prepare('PRAGMA table_info(settings)') // Get the table info for the settings table
  //       .all()
  //       .map((column) => column.name);
  //     if (!settingColumns.includes('max_storage_gb')) // Add the max_storage_gb column if it doesn't exist
  //       db.exec(
  //         'ALTER TABLE settings ADD COLUMN max_storage_gb INTEGER NOT NULL DEFAULT 100',
  //       );
  //   },
  // },
];

/**
 * Runs all pending migrations.
 * Stores the current schema version in the user_version PRAGMA.
 *
 * @param {import('better-sqlite3').Database} db
 */

export async function runMigrations(db) {
  console.log(
    `[DB-MIGRATION] Current user_version: ${db.prepare('PRAGMA user_version').get().user_version}`,
  );
  const userVersionRow = db.prepare('PRAGMA user_version').get();
  let currentVersion = userVersionRow.user_version || 0;

  const pending = migrations.filter(
    (migration) => migration.version > currentVersion,
  );

  for (const migration of pending) {
    console.log(
      `[DB-MIGRATION] Running migration: ${migration.name} (version ${migration.version})`,
    );
    await migration.up(db);
    currentVersion = migration.version;
    db.pragma(`user_version = ${currentVersion}`);
  }
}
