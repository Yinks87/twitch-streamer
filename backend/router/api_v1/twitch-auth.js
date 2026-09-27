import express from 'express';
import crypto from 'node:crypto';
import config from '../../config.js';
import * as db from '../../db/db.js';
import { getSessionToken } from '../../middleware/index.js';
import { authAPI, getStreamKey, twitchAPI } from '../../twitch/api.js';
const twitchAuthRouter = express.Router();

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REDIRECT_URI,
  FRONTEND_URL,
  TWITCH_PERMITTED_USER,
} = config;

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
}
const oauthStates = new Map();

function createOAuthState() {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  for (const [k, ts] of oauthStates) {
    if (Date.now() - ts > 10 * 60 * 1000) oauthStates.delete(k);
  }
  return state;
}

function consumeOAuthState(state) {
  if (!state || !oauthStates.has(state)) return false;
  oauthStates.delete(state);
  return true;
}

twitchAuthRouter.get('/twitch', (req, res) => {
  if (!TWITCH_CLIENT_ID) {
    return res
      .status(503)
      .json({ error: 'Twitch OAuth not configured (set TWITCH_CLIENT_ID)' });
  }
  const state = createOAuthState();

  const qs = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: TWITCH_REDIRECT_URI,
    response_type: 'code',
    scope:
      'channel:read:stream_key user:read:broadcast channel:manage:broadcast user:write:chat',
    state: state,
  });
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.search = qs.toString();
  res.redirect(url.toString());
});

twitchAuthRouter.get('/twitch/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const base = FRONTEND_URL || '';
  const successUrl = `${base}/app`;
  const errorUrl = `${base}/`;

  if (error)
    return res.redirect(`${errorUrl}?error=${encodeURIComponent(error)}`);
  if (!code || !consumeOAuthState(state)) {
    return res.redirect(`${errorUrl}?error=invalid_state`);
  }

  try {
    // Exchange code for tokens

    const qs = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: TWITCH_REDIRECT_URI,
    });

    const tokenRes = await authAPI.post('/token', qs);
    const tokens = tokenRes.data;
    if (!tokenRes.status || tokenRes.status !== 200)
      throw new Error(tokens.message || 'Token exchange failed');

    const { access_token, refresh_token, expires_in } = tokens;
    const tokenExpiresAt = new Date(
      Date.now() + expires_in * 1000,
    ).toISOString();

    // Fetch Twitch user info
    const userRes = await twitchAPI.get('/users', {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });
    const twitchUser = userRes.data?.data?.[0];
    if (!twitchUser) throw new Error('Failed to fetch Twitch user info');

    if (db.getUserCount() === 0) {
      const permitted = String(TWITCH_PERMITTED_USER || '')
        .trim()
        .toLowerCase();
      const matchesPermittedUser =
        permitted &&
        [twitchUser.id, twitchUser.login, twitchUser.display_name].some(
          (value) =>
            String(value || '')
              .trim()
              .toLowerCase() === permitted,
        );
      if (!matchesPermittedUser) {
        throw new Error(
          'Only the configured TWITCH_PERMITTED_USER may perform the first login.',
        );
      }
    }

    const existingUser = db.getUserByTwitchId(twitchUser.id);
    const permitted = String(TWITCH_PERMITTED_USER || '')
      .trim()
      .toLowerCase();
    const isPermittedUser =
      permitted &&
      [twitchUser.id, twitchUser.login, twitchUser.display_name].some(
        (value) =>
          String(value || '')
            .trim()
            .toLowerCase() === permitted,
      );
    const knownRoles = ['broadcaster', 'admin', 'manager'];
    if (!knownRoles.includes(existingUser?.role) && !isPermittedUser) {
      throw new Error(
        'This Twitch user is not authorized to use the application.',
      );
    }
    const role = isPermittedUser
      ? 'broadcaster'
      : existingUser?.role || 'manager';

    // Auto-save stream key to settings
    if (role === 'broadcaster') {
      const streamKey = await getStreamKey();
      db.saveSettings({ streamKey });
    }

    // Persist user and create session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    db.upsertUser({
      twitchUserId: twitchUser.id,
      login: twitchUser.login,
      displayName: twitchUser.display_name,
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenExpiresAt,
      broadcasterType: twitchUser.broadcaster_type,
      profileImageUrl: twitchUser.profile_image_url,
      role,
      sessionToken,
    });

    setSessionCookie(res, sessionToken);
    res.redirect(successUrl);
  } catch (err) {
    // console.error('OAuth callback error:', err);
    res.redirect(`${errorUrl}?error=${encodeURIComponent(err.message)}`);
  }
});

twitchAuthRouter.post('/logout', (req, res) => {
  db.clearSession(getSessionToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

twitchAuthRouter.get('/me', (req, res) => {
  const user = db.getUserBySession(getSessionToken(req));
  if (!user) return res.json({ user: null });
  const broadcaster = db.getBroadcasterUser();
  res.json({
    user: {
      twitchUserId: user.twitch_user_id,
      login: user.login,
      displayName: user.display_name,
      role: user.role,
      broadcasterType: broadcaster?.broadcaster_type ?? null,
      profileImageUrl: user.profile_image_url,
    },
  });
});

export default twitchAuthRouter;
