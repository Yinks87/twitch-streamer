export const getEventTypes = (bc) => [
  {
    type: 'channel.chat.message',
    version: '1',
    condition: {
      broadcaster_user_id: `${bc.twitch_user_id}`,
      user_id: `${bc.twitch_user_id}`,
    },
  },
];
