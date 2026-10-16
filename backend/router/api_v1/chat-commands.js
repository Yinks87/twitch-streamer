import express from 'express';
import * as db from '../../db/db.js';
import { requireAuth } from '../../middleware/index.js';

const chatCommandsRouter = express.Router();
chatCommandsRouter.use('/chat-commands', requireAuth(['admin', 'broadcaster']));

const ROLES = ['user', 'manager', 'admin'];
const NAME_PATTERN = /^[\p{L}\p{N}_]{1,25}$/u;
const MAX_RESPONSE_LENGTH = 500;
const MAX_COOLDOWN_SECONDS = 3600;

// Returns { fields } with the cleaned values, or { error }. Only provided keys are checked
// unless `requireAll` is set (creating a command).
function validateCommand(body, { requireAll }) {
  const fields = {};
  const { name, response, enabled, requiredRole, cooldownSeconds } = body || {};

  if (name !== undefined || requireAll) {
    const cleaned = String(name ?? '')
      .trim()
      .replace(/^!/, '')
      .toLowerCase();
    if (!NAME_PATTERN.test(cleaned))
      return {
        error:
          'Befehlsname: 1–25 Zeichen, nur Buchstaben, Zahlen und Unterstrich.',
      };
    fields.name = cleaned;
  }
  if (response !== undefined || requireAll) {
    const cleaned = String(response ?? '').trim();
    if (!cleaned || cleaned.length > MAX_RESPONSE_LENGTH)
      return {
        error: `Antwort: 1–${MAX_RESPONSE_LENGTH} Zeichen.`,
      };
    fields.response = cleaned;
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean')
      return { error: 'enabled must be a boolean' };
    fields.enabled = enabled;
  }
  if (requiredRole !== undefined) {
    if (!ROLES.includes(requiredRole))
      return { error: `requiredRole must be one of: ${ROLES.join(', ')}` };
    fields.requiredRole = requiredRole;
  }
  if (cooldownSeconds !== undefined) {
    if (
      !Number.isInteger(cooldownSeconds) ||
      cooldownSeconds < 0 ||
      cooldownSeconds > MAX_COOLDOWN_SECONDS
    )
      return {
        error: `Cooldown: ganze Zahl zwischen 0 und ${MAX_COOLDOWN_SECONDS} Sekunden.`,
      };
    fields.cooldownSeconds = cooldownSeconds;
  }
  return { fields };
}

function nameTaken(name, exceptId) {
  const existing = db.getChatCommandByName(name);
  return Boolean(existing && existing.id !== exceptId);
}

chatCommandsRouter.get('/chat-commands', (req, res) => {
  res.json({ commands: db.getChatCommands() });
});

chatCommandsRouter.post('/chat-commands', (req, res) => {
  const { fields, error } = validateCommand(req.body, { requireAll: true });
  if (error) return res.status(400).json({ error });
  if (nameTaken(fields.name))
    return res
      .status(409)
      .json({ error: `Der Befehl !${fields.name} existiert bereits.` });
  res.status(201).json({ command: db.addChatCommand(fields) });
});

chatCommandsRouter.patch('/chat-commands/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const { fields, error } = validateCommand(req.body, { requireAll: false });
  if (error) return res.status(400).json({ error });
  if (fields.name && nameTaken(fields.name, id))
    return res
      .status(409)
      .json({ error: `Der Befehl !${fields.name} existiert bereits.` });
  const command = db.updateChatCommand(id, fields);
  if (!command) return res.status(404).json({ error: 'Befehl nicht gefunden.' });
  res.json({ command });
});

chatCommandsRouter.delete('/chat-commands/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  if (!db.removeChatCommand(id))
    return res.status(404).json({ error: 'Befehl nicht gefunden.' });
  res.json({ ok: true });
});

export default chatCommandsRouter;
