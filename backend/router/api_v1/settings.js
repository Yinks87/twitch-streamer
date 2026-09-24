import express from 'express';
import config from '../../config.js';
import * as db from '../../db.js';
import { requireAuth } from '../../middleware/index.js';

const settingsRouter = express.Router();

function isPrivileged(user) {
  return user?.role === 'broadcaster' || user?.role === 'admin';
}

async function callUpdateService(path, method) {
  if (!config.UPDATE_SERVICE_URL || !config.UPDATE_SERVICE_TOKEN) {
    throw new Error('The update service is not configured on this server.');
  }

  const response = await fetch(new URL(path, config.UPDATE_SERVICE_URL), {
    method,
    headers: { 'X-Update-Service-Token': config.UPDATE_SERVICE_TOKEN },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Update service returned ${response.status}.`);
  }
  return data;
}

settingsRouter.get('/settings', requireAuth, (req, res) => {
  const settings = db.getSettings();
  if (!isPrivileged(req.user)) settings.streamKey = '';
  res.json(settings);
});

settingsRouter.post('/settings', requireAuth, (req, res) => {
  const {
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
  } = req.body || {};
  if (twitchServer !== undefined && typeof twitchServer !== 'string')
    return res.status(400).json({ error: 'twitchServer must be a string' });
  if (streamKey !== undefined && typeof streamKey !== 'string')
    return res.status(400).json({ error: 'streamKey must be a string' });
  if (!isPrivileged(req.user) && streamKey !== undefined)
    return res
      .status(403)
      .json({
        error: 'Only the broadcaster or an admin can change the stream key.',
      });
  if (
    videoBitrateKbps !== undefined &&
    (!Number.isInteger(videoBitrateKbps) ||
      videoBitrateKbps < 500 ||
      videoBitrateKbps > 10000)
  )
    return res
      .status(400)
      .json({
        error: 'videoBitrateKbps must be an integer between 500 and 10000',
      });
  if (
    audioBitrateKbps !== undefined &&
    (!Number.isInteger(audioBitrateKbps) ||
      audioBitrateKbps < 32 ||
      audioBitrateKbps > 320)
  )
    return res
      .status(400)
      .json({
        error: 'audioBitrateKbps must be an integer between 32 and 320',
      });
  if (
    streamFps !== undefined &&
    (!Number.isInteger(streamFps) || streamFps < 1 || streamFps > 120)
  )
    return res
      .status(400)
      .json({ error: 'streamFps must be an integer between 1 and 120' });
  if (
    restartIntervalSeconds !== undefined &&
    (!Number.isInteger(restartIntervalSeconds) ||
      restartIntervalSeconds < 0 ||
      restartIntervalSeconds > 604800)
  )
    return res
      .status(400)
      .json({
        error: 'restartIntervalSeconds must be an integer between 0 and 604800',
      });
  if (
    restartDelaySeconds !== undefined &&
    (!Number.isInteger(restartDelaySeconds) ||
      restartDelaySeconds < 0 ||
      restartDelaySeconds > 3600)
  )
    return res
      .status(400)
      .json({
        error: 'restartDelaySeconds must be an integer between 0 and 3600',
      });
  const saved = db.saveSettings({
    twitchServer,
    streamKey: isPrivileged(req.user) ? streamKey : undefined,
    playlistSource,
    altStreamer,
    loopPlaylist,
    videoBitrateKbps,
    audioBitrateKbps,
    streamFps,
    restartIntervalSeconds,
    restartDelaySeconds,
  });
  if (!isPrivileged(req.user)) saved.streamKey = '';
  res.json(saved);
});

settingsRouter.get('/app/update', requireAuth('admin'), async (req, res) => {
  try {
    res.json(await callUpdateService('/status', 'GET'));
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

settingsRouter.post('/app/update', requireAuth('admin'), async (req, res) => {
  try {
    res.status(202).json(await callUpdateService('/update', 'POST'));
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

export default settingsRouter;
