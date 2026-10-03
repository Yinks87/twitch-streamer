import { getTwitchUserRole, hasPermission } from '../lib.js';
import * as db from '../../db/db.js';
import { pinChatMessage } from '../api.js';

export async function handleChatMessage(eventSub) {
  const event = eventSub.event;
  const { source_broadcaster_user_id, broadcaster_user_id } = eventSub.event;
  const message = event.message.text;
  const settings = db.getSettings();
  const msgPinEnabled = settings?.pinMessageEnabled;
  const msgToPin = settings?.chatMessages?.pinMessage;

  // Check if the message comes from the broadcaster's channel
  if (
    source_broadcaster_user_id &&
    broadcaster_user_id !== source_broadcaster_user_id
  )
    return;

  if (msgPinEnabled && message === msgToPin) {
    await pinChatMessage(event.message_id);
  }
  // const args = message.split(' ');
  // const commandName = args[0].toLowerCase();
  // const commandArg = args.slice(1).join(' ').toLowerCase();
  // const aliasCommand = args[1]?.toLowerCase();
  // const alias = args[2]?.toLowerCase();
  // const aliasToRemove = args[1]?.toLowerCase();

  // const commandArgs = { commandArg, aliasCommand, alias, aliasToRemove };

  // const commandsArray = commandsConfig.get('commands').map((cmd) => ({ ...cmd }));
  // const allAliases = commandsArray.map((cmd) => cmd.cmd).flat();

  // Check if the command exists in the list of all aliases, otherwise ignore
  // if (!allAliases.includes(commandName)) return;

  // Find the command object based on the command name
  // const commandObject = commandsArray.find((cmd) => cmd.cmd.includes(commandName));
  // if (!commandObject) return;

  // Check if the command is enabled, if not ignore
  // if (!commandObject.enabled) return;

  // Check if the user has the required permissions to execute the command
  // const requiredCommandRole = commandObject.requiredRole;
  // if (!requiredCommandRole) return;

  // If the user has permissions, execute the command action

  // const serverSettings = serverConfig.get('');
  // const serverName = serverSettings.serverInstances?.[0]?.name || 'undefined';

  // const role = getTwitchUserRole({ event });
  // const remainingCooldownMs = getRemainingCommandCooldown({
  //   platform: 'twitch',
  //   commandId: commandObject.id,
  //   role,
  //   coolDowns: commandObject.coolDowns
  // });

  // if (remainingCooldownMs > 0) {
  //   Logger.info(`Command: ${commandName} is on cooldown for ${remainingCooldownMs}ms`);
  //   return;
  // }

  // if (
  //   hasPermission({
  //     event,
  //     requiredRole: requiredCommandRole,
  //     restricted: commandObject.restricted,
  //     inPrivacyScene: await ifCurrentSceneIsPrivacyScene()
  //   })
  // ) {
  //   commandActions({
  //     platform: 'twitch',
  //     messageService: twitchMessageService,
  //     server: serverName,
  //     switcherConfig,
  //     commandsConfig,
  //     accountConfig: twitchAccountsConfig
  //   })[commandObject.action](commandArgs);
  // }

  // startCommandCooldown({
  //   platform: 'twitch',
  //   commandId: commandObject.id,
  //   role,
  //   coolDowns: commandObject.coolDowns
  // });
}
