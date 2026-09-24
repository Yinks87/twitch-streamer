import { config as dotenvConfig } from "dotenv";
dotenvConfig();

/**
 * Configuration for environment variables
 */

/**
 * @typedef EnvironmentConfig
 * @prop {number | string} BACKEND_PORT - The port number for the backend server.
 * @prop {string} PORT - The port number for the backend server.
 * @prop {string} VIDEOS_DIR - The directory for storing video files.
 * @prop {string} DB_PATH - The path to the SQLite database file.
 * @prop {string} FFMPEG_PATH - The path to the ffmpeg executable.
 * @prop {string} YTDLP_PATH - The path to the yt-dlp executable.
 * @prop {string} TWITCH_CLIENT_ID - The client ID for Twitch authentication.
 * @prop {string} TWITCH_CLIENT_SECRET - The client secret for Twitch authentication.
 * @prop {string} TWITCH_REDIRECT_URI - The redirect URI for Twitch authentication.
  // Leave empty in production (same origin); set to e.g. http://localhost:5173 for Vite dev.
 * @prop {string} FRONTEND_URL - The URL of the frontend application.
 * @prop {string} SESSION_SECRET - The secret key for session management.
 * @prop {string} UPDATE_SERVICE_URL - The loopback host update service URL.
 * @prop {string} UPDATE_SERVICE_TOKEN - The shared token for the host update service.
 */

/**
 * @type {EnvironmentConfig}
 */

const config = {
  ...process.env,
  UPDATE_SERVICE_URL: process.env.UPDATE_SERVICE_URL || '',
  UPDATE_SERVICE_TOKEN: process.env.UPDATE_SERVICE_TOKEN || '',
};

export default config;
