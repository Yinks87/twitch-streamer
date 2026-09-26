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
          chat_messages           TEXT NOT NULL DEFAULT '{}',
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
    },
  },

  {
    version: 2,
    name: 'add_added_columns',
    up: (db) => {
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
      if (!settingColumns.includes('chat_messages_enabled'))
        db.exec(
          'ALTER TABLE settings ADD COLUMN chat_messages_enabled INTEGER NOT NULL DEFAULT 1',
        );
      if (!settingColumns.includes('chat_messages'))
        db.exec(
          "ALTER TABLE settings ADD COLUMN chat_messages TEXT NOT NULL DEFAULT '{}'",
        );
      const userColumns = db
        .prepare('PRAGMA table_info(users)')
        .all()
        .map((column) => column.name);
      if (!userColumns.includes('broadcaster_type'))
        db.exec('ALTER TABLE users ADD COLUMN broadcaster_type TEXT');
      if (!userColumns.includes('managers'))
        db.exec(
          "ALTER TABLE users ADD COLUMN managers TEXT NOT NULL DEFAULT '[]'",
        );
      if (!userColumns.includes('role'))
        db.exec(
          "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'manager'",
        );
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
    },
  },

  // Example of a future migration:
  // {
  //   version: 2,
  //   name: 'release_name',
  //   up: async (db) => {
  //     // Safe: only runs on existing DBs that predate the notes column
  //     await db.exec(
  //       `ALTER TABLE <TABLE> ADD COLUMN <COLUMNNAME> TEXT NOT NULL DEFAULT '[]'`,
  //     );
  //     await db.exec(
  //       `ALTER TABLE <TABLE> ADD COLUMN <COLUMNNAME> TEXT NOT NULL DEFAULT '[]'`,
  //     );
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
