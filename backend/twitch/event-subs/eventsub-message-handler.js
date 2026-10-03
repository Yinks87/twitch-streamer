import { handleChatMessage } from './handleChatMessage.js';

export function handleEventSub(eventSub) {
  const e = eventSub.subscription?.type
    ? eventSub.subscription?.type
    : eventSub.session?.status;

  switch (e) {
    case 'channel.chat.message':
      handleChatMessage(eventSub);
      break;
    case 'connected':
      console.info(`Connected to all eventsubs`);
      break;

    default:
      console.error(`Unknown event type...`);
      return { success: false };
  }
}
