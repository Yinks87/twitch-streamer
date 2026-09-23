import axios from 'axios';

import * as db from '../db.js';
import config from '../config.js';

const authAPI = axios.create({
  baseURL: 'https://id.twitch.tv/oauth2',
});

const twitchAPI = axios.create({
  baseURL: 'https://api.twitch.tv/helix',
});

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = config;

export async function validateAndProceed(access_token, callback) {
  if (!access_token) {
    throw new Error('No Twitch access token provided.');
  }

  const { access_token: validToken, success } = await doTokenValidationProcess({
    access_token,
  });

  if (!success) {
    throw new Error('Unable to validate Twitch or refresh access token.');
  }

  return await callback(validToken);
}

export async function doTokenValidationProcess({ access_token }) {
  const user = db.getUserByAccessToken(access_token);

  if (!user) {
    throw new Error('User not found for the provided access token.');
  }

  const validAccessToken = await validateAccessToken(access_token);
  if (validAccessToken) {
    return { access_token, success: true };
  }

  if (!user.refresh_token) {
    throw new Error('No refresh token available for Twitch user.');
  }

  const newAccessToken = await refreshAccessToken(user.refresh_token);
  if (!newAccessToken?.access_token) {
    throw new Error('Failed to refresh Twitch access token.');
  }

  db.db
    .prepare(
      `UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(
      newAccessToken.access_token,
      newAccessToken.refresh_token ?? user.refresh_token,
      new Date(
        Date.now() + (newAccessToken.expires_in ?? 3600) * 1000,
      ).toISOString(),
      user.id,
    );

  return { access_token: newAccessToken.access_token, success: true };
}

export async function validateAccessToken(access_token) {
  try {
    const { data } = await authAPI.get('/validate', {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });
    return data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      return null;
    }
    console.error('Error validating access token:', error.message || error);
    return null;
  }
}

export async function refreshAccessToken(refresh_token) {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
    });

    const { data } = await authAPI.post('/token', body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return data;
  } catch (error) {
    throw new Error(
      `Failed to refresh access token: ${error.response ? JSON.stringify(error.response.data) : error.message}`,
    );
  }
}

export async function revokeTwitchAccessToken(access_token) {
  try {
    const params = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      token: access_token,
    });

    const { data, status, statusText } = await authAPI.post('/revoke', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return { status, message: statusText, data };
  } catch (error) {
    const resData = {
      status: error.response ? error.response.status : 400,
      message: error.response
        ? error.response.data?.message || error.message
        : error.message,
    };
    return resData;
  }
}

export async function resolveCategoryId(access_token, categoryNameOrId) {
  if (!categoryNameOrId) return null;
  const value = String(categoryNameOrId).trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;

  try {
    const { data } = await twitchAPI.get('/search/categories', {
      params: {
        query: value,
        first: 1,
      },
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    });

    return data?.data?.[0]?.id ?? null;
  } catch (error) {
    console.error(
      '[twitch-api] category lookup failed:',
      error.message || error,
    );
    return null;
  }
}

export async function applyChannelUpdate(
  access_token,
  title,
  category,
  category_id = null,
) {
  return await validateAndProceed(access_token, async (validToken) => {
    try {
      const user = db.getUserByAccessToken(validToken);
      if (!user) {
        throw new Error('No Twitch user found for the valid access token.');
      }

      const resolvedCategoryId = await resolveCategoryId(
        validToken,
        category_id ?? category,
      );

      const body = {};
      if (title) body.title = title;
      if (resolvedCategoryId) body.game_id = String(resolvedCategoryId);

      if (!Object.keys(body).length) return null;

      const { data } = await twitchAPI.patch(
        `/channels?broadcaster_id=${encodeURIComponent(user.twitch_user_id)}`,
        body,
        {
          headers: {
            Authorization: `Bearer ${validToken}`,
            'Client-Id': TWITCH_CLIENT_ID,
            'Content-Type': 'application/json',
          },
        },
      );

      return data;
    } catch (error) {
      throw new Error(
        `Failed to update channel information: ${error.response ? JSON.stringify(error.response.data) : error.message}`,
      );
    }
  });
}

export async function validateStoredUserTokens() {
  const rows = db.db
    .prepare('SELECT * FROM users WHERE access_token IS NOT NULL')
    .all();

  for (const user of rows) {
    try {
      await doTokenValidationProcess({ access_token: user.access_token });
      console.log(
        `[twitch-token] validated user ${user.display_name || user.login}`,
      );
    } catch (error) {
      console.warn(
        `[twitch-token] validation failed for user ${user.display_name || user.login}: ${error.message}`,
      );
    }
  }

  return rows.length;
}

export function startAccessTokenValidationLoop(intervalMs = 59 * 60 * 1000) {
  if (globalThis.__twitchTokenValidationLoop) {
    return globalThis.__twitchTokenValidationLoop;
  }

  const run = async () => {
    try {
      const total = await validateStoredUserTokens();
      console.log(`[twitch-token] checked ${total} stored Twitch users.`);
    } catch (error) {
      console.error('[twitch-token] validation loop failed:', error.message);
    }
  };

  run();
  const timer = setInterval(() => {
    run();
  }, intervalMs);

  globalThis.__twitchTokenValidationLoop = { timer, intervalMs };
  return globalThis.__twitchTokenValidationLoop;
}
