import express from 'express';
import * as db from '../../db/db.js';
import { requireAuth } from '../../middleware/index.js';
import * as streamManager from '../../streamManager.js';
import { validateAndProceed } from '../../twitch/api.js';

const streamRouter = express.Router();
const STREAMER_DATA_ERROR =
  'Fehler beim Abrufen der Streamer Daten, erneute Anmeldung des Streamers erforderlich...';

async function refreshBroadcasterData() {
  const broadcaster = db.getBroadcasterUser();
  if (!broadcaster?.access_token) throw new Error(STREAMER_DATA_ERROR);

  try {
    const refreshed = await validateAndProceed(
      broadcaster.access_token,
      async (accessToken) => {
        const headers = {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': process.env.TWITCH_CLIENT_ID,
        };
        const userResponse = await fetch(
          `https://api.twitch.tv/helix/users?id=${encodeURIComponent(broadcaster.twitch_user_id)}`,
          { headers },
        );
        const userData = await userResponse.json();
        if (!userResponse.ok || !userData.data?.[0])
          throw new Error('Twitch user lookup failed');

        const keyResponse = await fetch(
          `https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(userData.data[0].id)}`,
          { headers },
        );
        const keyData = await keyResponse.json();
        const streamKey = keyData.data?.[0]?.stream_key;
        if (!keyResponse.ok || !streamKey)
          throw new Error('Twitch stream key lookup failed');
        return { user: userData.data[0], streamKey };
      },
    );

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

streamRouter.get('/stream/logs', (req, res) => {
  res.json({ logs: streamManager.listLogFiles() });
});

streamRouter.get('/stream/logs/:filename/download', (req, res) => {
  const filePath = streamManager.getLogFilePath(req.params.filename);
  if (!filePath) return res.status(404).json({ error: 'Log file not found' });
  res.download(filePath, req.params.filename);
});

streamRouter.get('/stream/logs/:filename', (req, res) => {
  const log = streamManager.readLogFile(req.params.filename);
  if (!log) return res.status(404).json({ error: 'Log file not found' });
  res.json(log);
});

streamRouter.delete('/stream/logs/:filename', (req, res) => {
  const success = streamManager.deleteLogFile(req.params.filename);
  if (!success) return res.status(404).json({ error: 'Log file not found' });
  res.json({ ok: true });
});

streamRouter.post('/stream/start', requireAuth, async (req, res) => {
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
});

streamRouter.post('/stream/stop', requireAuth, (req, res) => {
  res.json(streamManager.stopStream());
});

streamRouter.get('/health', (req, res) => res.json({ ok: true }));

export default streamRouter;
