import { getEventTypes } from './eventsub-types.js';
import { handleEventSub } from './eventsub-message-handler.js';
import WebSocket from 'ws';
import * as db from '../../db/db.js';
import config from '../../config.js';
import { doTokenValidationProcess } from '../api.js';

const WS_ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
const SUBSCRIPTIONS_ENDPOINT =
  'https://api.twitch.tv/helix/eventsub/subscriptions';
const HEARTBEAT_CHECK_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const RECONNECT_DELAY_MS = 5000;
const SUBSCRIBE_RETRY_ATTEMPTS = 3;

let ws = null;
let heartbeatInterval = null;
let lastKeepAliveMessage = Date.now();
let reconnecting = false;
// Incremented on every (re)start so a superseded connection loop stops itself.
let connectionGeneration = 0;
let wakeConnectionLoop = null;

const { TWITCH_CLIENT_ID } = config;

// Always reads the broadcaster from the DB and validates/refreshes its token,
// because the stored tokens change whenever a login or the validation loop refreshes them.
async function getBroadcasterWithValidToken() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const bc = db.getBroadcasterUser();
    if (!bc?.access_token) {
      throw new Error('Missing broadcaster credentials.');
    }
    try {
      await doTokenValidationProcess({ access_token: bc.access_token });
      // The validation may have stored a refreshed token, so re-read the row.
      const fresh = db.getBroadcasterUser();
      if (!fresh?.access_token) {
        throw new Error('Missing broadcaster credentials.');
      }
      return fresh;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Main entry
export async function connectToTwitchEventSubs() {
  let bc = db.getBroadcasterUser();

  if (!bc?.access_token) {
    console.error(
      '[EVENTSUB] Missing broadcaster credentials. Aborting EventSub connection.',
    );
    return;
  }

  if (!bc.login) {
    console.error(
      '[EVENTSUB] No Twitch channel configured. Skipping EventSub connection.',
    );
    return;
  }

  const generation = ++connectionGeneration;
  const isCurrent = () => reconnecting && generation === connectionGeneration;

  await cleanupWebSocket();
  reconnecting = true;

  while (isCurrent()) {
    try {
      console.log(
        '[EVENTSUB] Attempting to connect to Twitch EventSub WebSocket...',
      );
      await connectOnce();
      await waitForSocketExit();
    } catch (err) {
      console.error(`[EVENTSUB] Connection failed: ${err.message}`);
    } finally {
      if (generation === connectionGeneration) await cleanupWebSocket();
    }

    if (!isCurrent()) {
      break;
    }

    console.warn(
      `[EVENTSUB] WebSocket closed or errored. Reconnecting in ${RECONNECT_DELAY_MS / 1000} seconds...`,
    );
    await delay(RECONNECT_DELAY_MS);
  }
}

// One connection attempt
async function connectOnce() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_ENDPOINT);
    let settled = false;

    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const safeReject = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    ws.once('open', () => {
      console.log('[EVENTSUB] WebSocket connected.');
      lastKeepAliveMessage = Date.now();
      startHeartbeatMonitor();
      safeResolve();
    });

    ws.on('message', (data) => {
      processMessage(data).catch((err) => {
        console.error(`Failed to process EventSub message: ${err.message}`);
      });
    });

    ws.once('error', (err) => {
      console.error(`WebSocket error: ${err.message}`);
      safeReject(err);
    });

    ws.once('close', () => {
      console.log('[EVENTSUB] WebSocket closed');
    });
  });
}

// Disconnect + cleanup
export async function disconnectTwitchEventSubs() {
  console.log('[EVENTSUB] Manual disconnect from EventSub...');
  reconnecting = false;
  await cleanupWebSocket();
}

// Kill timers and socket
async function cleanupWebSocket() {
  stopHeartbeatMonitor();
  if (ws) {
    try {
      ws.removeAllListeners();
      if (typeof ws.terminate === 'function') {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch (err) {
      console.error(`[EVENTSUB] Error terminating WebSocket: ${err.message}`);
    }
    ws = null;
  }
  // The removed listeners can no longer signal the loop, so wake it explicitly.
  wakeConnectionLoop?.();
}

// Subscription logic
export async function subscribeToChannelEvents(sessionId) {
  let bc;
  try {
    bc = await getBroadcasterWithValidToken();
  } catch (err) {
    console.error(
      `[EVENTSUB] Token validation failed, cannot subscribe: ${err.message}`,
    );
    return { success: false };
  }

  const channelName = bc.login;

  if (!channelName) {
    console.error(
      '[EVENTSUB] No channel login provided for EventSub subscription.',
    );
    return { success: false };
  }

  try {
    const broadcaster = bc;
    if (!broadcaster?.twitch_user_id) {
      console.error(
        `[EVENTSUB] Unable to resolve broadcaster ID for ${channelName}.`,
      );
      return { success: false };
    }

    const eventTypes = getEventTypes(broadcaster) || [];

    if (!eventTypes.length) {
      console.warn(
        `[EVENTSUB] No EventSub definitions available for ${channelName}.`,
      );
      return { success: true };
    }

    const results = await Promise.allSettled(
      eventTypes.map(({ type, version, condition }) =>
        subscribeToEvent(bc, type, version, condition, sessionId),
      ),
    );

    const hadErrors = results.some((result) => {
      if (result.status === 'rejected') {
        return true;
      }
      return result.value === null;
    });

    if (hadErrors) {
      console.error(
        `[EVENTSUB] One or more EventSub subscriptions failed for ${channelName}.`,
      );
    }

    return { success: !hadErrors };
  } catch (err) {
    console.error(
      `[EVENTSUB] Failed to subscribe to ${channelName}: ${err.message}`,
    );

    return { success: false };
  }
}

async function subscribeToEvent(bc, type, version, condition, sessionId) {
  const payload = {
    type,
    version,
    condition,
    transport: {
      method: 'websocket',
      session_id: sessionId,
    },
  };

  for (let attempt = 1; attempt <= SUBSCRIBE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(SUBSCRIPTIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bc.access_token}`,
          'Client-ID': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error(
          `[EVENTSUB] Failed to subscribe to ${type} for ${bc.display_name} (attempt ${attempt}/${SUBSCRIBE_RETRY_ATTEMPTS}): ${JSON.stringify(body)}`,
        );
        if (attempt === SUBSCRIBE_RETRY_ATTEMPTS) {
          return null;
        }
        await delay(250 * attempt);
        continue;
      }

      const data = body?.data || [];

      if (data[0]?.type === 'channel.chat.message') {
        console.log(`[EVENTSUB] Joined channel ${capitalize(bc.login)}`);
        // } else if (data[0]?.type === 'channel.raid') {
        //   console.log(`Subscribed to raid event for ${capitalize(bc.login)}`);
      } else {
        console.log(
          `[EVENTSUB] Subscribed to ${type} for ${capitalize(bc.login)}`,
        );
      }

      return data;
    } catch (err) {
      console.error(
        `[EVENTSUB] Error subscribing to ${type} for ${bc.display_name} (attempt ${attempt}/${SUBSCRIBE_RETRY_ATTEMPTS}): ${err.message}`,
      );
      if (attempt === SUBSCRIBE_RETRY_ATTEMPTS) {
        return null;
      }
      await delay(250 * attempt);
    }
  }

  return null;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function processMessage(rawMessage) {
  const message = safeJsonParse(rawMessage);
  if (!message) {
    return;
  }

  const type = message.metadata?.message_type;

  switch (type) {
    case 'ping':
      sendPong();
      return;
    case 'session_keepalive':
      lastKeepAliveMessage = Date.now();
      return;
    case 'session_welcome': {
      lastKeepAliveMessage = Date.now();
      const sessionId = message.payload?.session?.id;
      if (!sessionId) {
        console.error('[EVENTSUB] Missing session ID in welcome payload.');
        return;
      }
      await subscribeToChannelEvents(sessionId);
      return;
    }
    case 'session_reconnect':
      console.warn(
        '[EVENTSUB] Twitch requested an EventSub session reconnect. Restarting socket...',
      );
      ws?.close(4001, 'Reconnecting');
      return;
    default:
      break;
  }

  if (type === 'notification' && message.payload) {
    handleEventSub(message.payload);
    lastKeepAliveMessage = Date.now();
  }
}

function sendPong() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[EVENTSUB] Cannot send pong, WebSocket not open.');
    return;
  }
  ws.send(JSON.stringify({ metadata: { message_type: 'pong' } }));
}

function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  heartbeatInterval = setInterval(() => {
    if (Date.now() - lastKeepAliveMessage > HEARTBEAT_TIMEOUT_MS) {
      console.error('[EVENTSUB] WebSocket heartbeat lost. Terminating...');
      ws?.close(4000, 'Heartbeat timeout');
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

function stopHeartbeatMonitor() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function safeJsonParse(raw) {
  try {
    const value = typeof raw === 'string' ? raw : raw.toString();
    return JSON.parse(value);
  } catch (err) {
    console.error(
      `[EVENTSUB] Failed to parse EventSub message: ${err.message}`,
    );
    return null;
  }
}

async function waitForSocketExit() {
  if (!ws) {
    return;
  }

  await new Promise((resolve) => {
    const finalize = () => {
      wakeConnectionLoop = null;
      resolve();
    };

    wakeConnectionLoop = finalize;
    ws.once('close', finalize);
    ws.once('error', finalize);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
