import express from 'express';
import * as db from '../../db/db.js';
import config from '../../config.js';
import { requireAuth } from '../../middleware/index.js';
import * as streamManager from '../../streamManager.js';
import { getBroadcasterData, validateAndProceed } from '../../twitch/api.js';

const streamRouter = express.Router();
const STREAMER_DATA_ERROR =
  'Fehler beim Abrufen der Streamer Daten, erneute Anmeldung des Streamers erforderlich...';

async function refreshBroadcasterData() {
  const broadcaster = db.getBroadcasterUser();
  if (!broadcaster?.access_token) throw new Error(STREAMER_DATA_ERROR);

  const refreshed = await getBroadcasterData();
  try {
    db.db
      .prepare(
        `
      UPDATE users
      SET login = ?, display_name = ?, broadcaster_type = ?, profile_image_url = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
      )
      .run(
        refreshed.user.login,
        refreshed.user.display_name,
        refreshed.user.broadcaster_type ?? null,
        refreshed.user.profile_image_url ?? null,
        broadcaster.id,
      );
    db.saveSettings({ streamKey: refreshed.streamKey });
    return refreshed;
  } catch {
    throw new Error(STREAMER_DATA_ERROR);
  }
}

streamRouter.get('/stream/status', (req, res) => {
  res.json(streamManager.getStatus());
});

streamRouter.get(
  '/stream/logs',
  requireAuth(['admin', 'broadcaster']),
  (req, res) => {
    res.json({ logs: streamManager.listLogFiles() });
  },
);

streamRouter.get(
  '/stream/logs/:filename/download',
  requireAuth(['admin', 'broadcaster']),
  (req, res) => {
    const filePath = streamManager.getLogFilePath(req.params.filename);
    if (!filePath) return res.status(404).json({ error: 'Log file not found' });
    res.download(filePath, req.params.filename);
  },
);

streamRouter.get(
  '/stream/logs/:filename',
  requireAuth(['admin', 'broadcaster']),
  (req, res) => {
    const log = streamManager.readLogFile(req.params.filename);
    if (!log) return res.status(404).json({ error: 'Log file not found' });
    res.json(log);
  },
);

streamRouter.delete(
  '/stream/logs/:filename',
  requireAuth(['admin', 'broadcaster']),
  (req, res) => {
    const success = streamManager.deleteLogFile(req.params.filename);
    if (!success) return res.status(404).json({ error: 'Log file not found' });
    res.json({ ok: true });
  },
);

streamRouter.post(
  '/stream/start',
  requireAuth(['admin', 'broadcaster']),
  async (req, res) => {
    try {
      await refreshBroadcasterData();
      const {
        twitchServer,
        streamKey,
        loopPlaylist,
        videoBitrateKbps,
        audioBitrateKbps,
        streamFps,
        restartIntervalSeconds,
        restartDelaySeconds,
      } = db.getSettings();
      res.json(
        await streamManager.startStream({
          twitchServer,
          streamKey,
          loop: loopPlaylist,
          videoBitrateKbps,
          audioBitrateKbps,
          streamFps,
          restartIntervalSeconds,
          restartDelaySeconds,
        }),
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

streamRouter.post(
  '/stream/stop',
  requireAuth(['admin', 'broadcaster']),
  (req, res) => {
    res.json(streamManager.stopStream());
  },
);

streamRouter.get('/health', (req, res) => res.json({ ok: true }));

export default streamRouter;
