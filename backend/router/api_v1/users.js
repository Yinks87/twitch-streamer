import express from 'express';

import config from '../../config.js';
import * as db from '../../db.js';
import { requireAuth } from '../../middleware/index.js';

const usersRouter = express.Router();
const { TWITCH_CLIENT_ID } = config;

function requireBroadcaster(req, res, next) {
  if (!['broadcaster', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Only the broadcaster or an admin can manage users.' });
  }
  next();
}

usersRouter.use(requireAuth, requireBroadcaster);

usersRouter.get('/users/managers', (req, res) => {
  res.json({ managers: db.getManagers() });
});

usersRouter.post('/users/managers', async (req, res) => {
  const login = String(req.body?.login || '').trim().toLowerCase();
  if (!login) return res.status(400).json({ error: 'Twitch login is required' });
  const requestedRole = String(req.body?.role || 'manager').trim().toLowerCase();
  if (!['manager', 'admin'].includes(requestedRole)) {
    return res.status(400).json({ error: "role must be 'manager' or 'admin'" });
  }

  const existing = db.getUserByAccessToken(req.user.access_token);
  if (!existing) return res.status(401).json({ error: 'Broadcaster account not found' });

  try {
    const twitchRes = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
      {
        headers: {
          Authorization: `Bearer ${req.user.access_token}`,
          'Client-Id': TWITCH_CLIENT_ID,
        },
      },
    );
    const data = await twitchRes.json();
    if (!twitchRes.ok) return res.status(502).json({ error: data.message || 'Twitch user lookup failed' });
    const twitchUser = data.data?.[0];
    if (!twitchUser) return res.status(404).json({ error: 'Twitch user not found' });

    const byId = db.getUserByTwitchId(twitchUser.id);
    if (byId) {
      return res.status(409).json({ error: 'This Twitch user is already registered.' });
    }

    const manager = db.addManager({
      twitchUserId: twitchUser.id,
      login: twitchUser.login,
      displayName: twitchUser.display_name,
      broadcasterType: twitchUser.broadcaster_type,
      profileImageUrl: twitchUser.profile_image_url,
      role: requestedRole,
    });
    res.status(201).json({ manager });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

usersRouter.delete('/users/managers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid manager id' });
  if (!db.removeManager(id)) return res.status(404).json({ error: 'Manager not found' });
  res.json({ ok: true });
});

export default usersRouter;
