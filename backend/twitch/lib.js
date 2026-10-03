import * as db from '../db/db.js';

export const hasPermission = ({ event, requiredRole }) => {
  const role = getTwitchUserRole({ event });

  const isBroadcaster = role === 'broadcaster';
  const isAdmin = role === 'admin';
  const isManager = role === 'manager';

  // If the command is restricted and the current scene is the privacy scene, only allow broadcaster and admins to execute it
  // Broadcaster has all permissions, always return true
  if (isBroadcaster) return true;
  if (requiredRole === 'user') return true;
  if (requiredRole === 'admin') return isAdmin;
  if (requiredRole === 'manager') return isAdmin || isManager;
  return false;
};

export const getTwitchUserRole = ({ event }) => {
  const { broadcaster_user_id, chatter_user_id, badges } = event;

  // Get admins and managers from the database
  const isBroadcaster = broadcaster_user_id === chatter_user_id;
  const users = db.getManagers();

  const managers = users
    .filter((user) => user.role === 'manager')
    .map((user) => user.id);
  const admins = users
    .filter((user) => user.role === 'admin')
    .map((user) => user.id);

  const isAdmin = admins.includes(event.chatter_user_id);
  const isManager =
    managers.includes(event.chatter_user_id) ||
    (badges.length > 0 &&
      badges.some(
        (badge) =>
          badge.set_id === 'moderator' || badge.set_id === 'lead_moderator',
      ));

  if (isBroadcaster) return 'broadcaster';
  if (isAdmin) return 'admin';
  if (isManager) return 'manager';
  return 'user';
};
