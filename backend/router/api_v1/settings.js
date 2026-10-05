import express from 'express';
import * as db from '../../db/db.js';
import { requireAuth } from '../../middleware/index.js';

const settingsRouter = express.Router();

const ENCODER_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
];

function isPrivileged(user) {
  return user?.role === 'broadcaster' || user?.role === 'admin';
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
    shuffleMode,
    videoBitrateKbps,
    audioBitrateKbps,
    streamFps,
    encoderPreset,
    restartIntervalSeconds,
    restartDelaySeconds,
    chatMessages,
    chatMessagesEnabled,
    pinMessageEnabled,
    maxStorageGb,
  } = req.body || {};
  if (encoderPreset !== undefined && !ENCODER_PRESETS.includes(encoderPreset))
    return res.status(400).json({
      error: `encoderPreset must be one of: ${ENCODER_PRESETS.join(', ')}`,
    });
  if (twitchServer !== undefined && typeof twitchServer !== 'string')
    return res.status(400).json({ error: 'twitchServer must be a string' });
  if (streamKey !== undefined && typeof streamKey !== 'string')
    return res.status(400).json({ error: 'streamKey must be a string' });
  if (!isPrivileged(req.user) && streamKey !== undefined)
    return res.status(403).json({
      error: 'Only the broadcaster or an admin can change the stream key.',
    });
  if (
    videoBitrateKbps !== undefined &&
    (!Number.isInteger(videoBitrateKbps) ||
      videoBitrateKbps < 500 ||
      videoBitrateKbps > 10000)
  )
    return res.status(400).json({
      error: 'videoBitrateKbps must be an integer between 500 and 10000',
    });
  if (
    audioBitrateKbps !== undefined &&
    (!Number.isInteger(audioBitrateKbps) ||
      audioBitrateKbps < 32 ||
      audioBitrateKbps > 320)
  )
    return res.status(400).json({
      error: 'audioBitrateKbps must be an integer between 32 and 320',
    });
  if (
    streamFps !== undefined &&
    (!Number.isInteger(streamFps) || streamFps < 30 || streamFps > 120)
  )
    return res
      .status(400)
      .json({ error: 'streamFps must be an integer between 30 and 120' });
  if (
    restartIntervalSeconds !== undefined &&
    (!Number.isInteger(restartIntervalSeconds) ||
      restartIntervalSeconds < 0 ||
      restartIntervalSeconds > 604800)
  )
    return res.status(400).json({
      error: 'restartIntervalSeconds must be an integer between 0 and 604800',
    });
  if (
    restartDelaySeconds !== undefined &&
    (!Number.isInteger(restartDelaySeconds) ||
      restartDelaySeconds < 0 ||
      restartDelaySeconds > 3600)
  )
    return res.status(400).json({
      error: 'restartDelaySeconds must be an integer between 0 and 3600',
    });
  if (chatMessages !== undefined && typeof chatMessages !== 'object')
    return res.status(400).json({ error: 'chatMessages must be an object' });
  if (
    chatMessagesEnabled !== undefined &&
    typeof chatMessagesEnabled !== 'boolean'
  )
    return res
      .status(400)
      .json({ error: 'chatMessagesEnabled must be a boolean' });
  if (
    pinMessageEnabled !== undefined &&
    typeof pinMessageEnabled !== 'boolean'
  )
    return res
      .status(400)
      .json({ error: 'pinMessageEnabled must be a boolean' });
  if (shuffleMode !== undefined && typeof shuffleMode !== 'boolean')
    return res.status(400).json({ error: 'shuffleMode must be a boolean' });
  if (
    maxStorageGb !== undefined &&
    (!Number.isInteger(maxStorageGb) || maxStorageGb < 1 || maxStorageGb > 100000)
  )
    return res
      .status(400)
      .json({ error: 'maxStorageGb must be an integer between 1 and 100000' });
  const saved = db.saveSettings({
    twitchServer,
    streamKey: isPrivileged(req.user) ? streamKey : undefined,
    playlistSource,
    altStreamer,
    loopPlaylist,
    shuffleMode,
    videoBitrateKbps,
    audioBitrateKbps,
    streamFps,
    encoderPreset,
    restartIntervalSeconds,
    restartDelaySeconds,
    chatMessages,
    chatMessagesEnabled,
    pinMessageEnabled,
    maxStorageGb,
  });
  if (!isPrivileged(req.user)) saved.streamKey = '';
  res.json(saved);
});

settingsRouter.get(
  '/app/update',
  requireAuth(['broadcaster', 'admin']),
  (req, res) => {},
);

export default settingsRouter;
