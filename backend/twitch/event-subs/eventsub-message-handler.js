import { handleChatMessage } from './handleChatMessage.js';
import * as streamManager from '../../streamManager.js';

export function handleEventSub(eventSub) {
  const e = eventSub.subscription?.type
    ? eventSub.subscription?.type
    : eventSub.session?.status;

  switch (e) {
    case 'channel.chat.message':
      handleChatMessage(eventSub);
      break;
    case 'stream.online':
      console.info(`[TWITCH] Stream is online`);
      break;
    case 'stream.offline':
      console.info(`[TWITCH] Stream is offline`);
      // {
      //   const result = streamManager.handleStreamOffline();
      //   if (result.restarted) {
      //     console.info(`[TWITCH] Unintended stream end detected, restarting stream...`);
      //   }
      // }
      break;
    case 'connected':
      console.info(`[TWITCH] Connected to all eventsubs`);
      break;

    default:
      console.error(`[TWITCH] Unknown event type...`);
      return { success: false };
  }
}
