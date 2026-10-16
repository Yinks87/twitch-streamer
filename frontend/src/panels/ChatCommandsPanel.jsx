import { useCallback, useEffect, useState } from 'react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { Input, Select } from '../components/FormControls';
import Checkbox from '../components/Checkbox';
import Button from '../components/Button';
import { api } from '../api';
import { useAlert } from '../context/AlertContext';

const ROLE_LABELS = {
  user: 'Alle',
  manager: 'Manager & Mods',
  admin: 'Admins',
};

const EMPTY_COMMAND = {
  id: null,
  name: '',
  response: '',
  enabled: true,
  requiredRole: 'user',
  cooldownSeconds: 5,
};

function CommandRow({ command, onSaved, onDeleted }) {
  const { showAlert } = useAlert();
  const isNew = command.id === null;
  const [draft, setDraft] = useState(command);
  const [busy, setBusy] = useState(false);
  const isDirty = isNew || JSON.stringify(draft) !== JSON.stringify(command);

  useEffect(() => setDraft(command), [command]);

  const update = (fields) => setDraft((current) => ({ ...current, ...fields }));

  async function save() {
    setBusy(true);
    try {
      const payload = {
        name: draft.name,
        response: draft.response,
        enabled: draft.enabled,
        requiredRole: draft.requiredRole,
        cooldownSeconds: Number(draft.cooldownSeconds),
      };
      const { command: saved } = isNew
        ? await api.addChatCommand(payload)
        : await api.updateChatCommand(command.id, payload);
      onSaved(saved);
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (isNew) return onDeleted(command);
    setBusy(true);
    try {
      await api.removeChatCommand(command.id);
      onDeleted(command);
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
      setBusy(false);
    }
  }

  return (
    <Row $disabled={!draft.enabled}>
      <NameField>
        <Bang>!</Bang>
        <Input
          aria-label="Befehlsname"
          placeholder="befehl"
          value={draft.name}
          maxLength={25}
          onChange={(e) => update({ name: e.target.value.replace(/^!/, '') })}
        />
      </NameField>
      <Input
        aria-label="Antwort"
        placeholder='z. B. Läuft gerade: "${title}" in ${category}'
        value={draft.response}
        maxLength={500}
        onChange={(e) => update({ response: e.target.value })}
      />
      <Select
        aria-label="Wer darf den Befehl nutzen"
        value={draft.requiredRole}
        onChange={(e) => update({ requiredRole: e.target.value })}
      >
        {Object.entries(ROLE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <CooldownField title="Mindestabstand zwischen zwei Antworten in Sekunden">
        <Input
          type="number"
          aria-label="Cooldown in Sekunden"
          min={0}
          max={3600}
          value={draft.cooldownSeconds}
          onChange={(e) => update({ cooldownSeconds: e.target.value })}
        />
        <span>s</span>
      </CooldownField>
      <Checkbox
        checked={draft.enabled}
        onChange={(e) => update({ enabled: e.target.checked })}
        label="Aktiv"
      />
      <Actions>
        <Button
          type="button"
          variant="primary"
          onClick={save}
          disabled={busy || !isDirty || !draft.name || !draft.response}
          title="Speichern"
        >
          <span className="material-symbols-outlined small">save</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          danger
          onClick={remove}
          disabled={busy}
          title="Löschen"
        >
          <span className="material-symbols-outlined small">delete</span>
        </Button>
      </Actions>
    </Row>
  );
}

const ChatCommandsPanel = () => {
  const { showAlert } = useAlert();
  const [commands, setCommands] = useState([]);
  const [drafts, setDrafts] = useState([]); // unsaved new commands
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.getChatCommands();
      setCommands(data.commands);
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }, [showAlert]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <CollapsiblePanel storageKey="chatCommands" title="Chat-Befehle">
      <Hint>
        Eigene Befehle für den Twitch-Chat, z. B. <code>!video</code>. Die
        Antwort kann diese Variablen enthalten:
      </Hint>
      <Variables>
        <li>
          <code>{'${title}'}</code> Titel des laufenden Abschnitts
        </li>
        <li>
          <code>{'${category}'}</code> Kategorie des laufenden Abschnitts
        </li>
        <li>
          <code>{'${streamedat}'}</code> Datum, an dem das Video auf Twitch
          übertragen wurde
        </li>
        <li>
          <code>{'${uploadedat}'}</code> Datum, an dem das Video hinzugefügt
          wurde
        </li>
      </Variables>

      <List>
        {loading && <Hint>Lade Befehle…</Hint>}
        {!loading && commands.length === 0 && drafts.length === 0 && (
          <Hint>Noch keine Befehle angelegt.</Hint>
        )}
        {commands.map((command) => (
          <CommandRow
            key={command.id}
            command={command}
            onSaved={(saved) =>
              setCommands((list) =>
                list.map((item) => (item.id === saved.id ? saved : item)),
              )
            }
            onDeleted={(removed) =>
              setCommands((list) =>
                list.filter((item) => item.id !== removed.id),
              )
            }
          />
        ))}
        {drafts.map((draft) => (
          <CommandRow
            key={draft.key}
            command={draft}
            onSaved={(saved) => {
              setDrafts((list) => list.filter((item) => item !== draft));
              setCommands((list) => [...list, saved]);
            }}
            onDeleted={() =>
              setDrafts((list) => list.filter((item) => item !== draft))
            }
          />
        ))}
      </List>
      <div>
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            setDrafts((list) => [
              ...list,
              { ...EMPTY_COMMAND, key: `new-${Date.now()}` },
            ])
          }
        >
          <span className="material-symbols-outlined small">add</span> Neuer
          Befehl
        </Button>
      </div>
    </CollapsiblePanel>
  );
};

export default ChatCommandsPanel;

const Hint = styled.p`
  margin: 0 0 10px;
  color: var(--text-dim);
  font-size: 0.85rem;
`;

const Variables = styled.ul`
  margin: 0 0 14px;
  padding-left: 18px;
  color: var(--text-dim);
  font-size: 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: minmax(110px, 0.6fr) minmax(200px, 2fr) auto auto auto auto;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-raised);
  opacity: ${({ $disabled }) => ($disabled ? 0.6 : 1)};

  @media (max-width: 900px) {
    grid-template-columns: 1fr 1fr;
  }
`;

const NameField = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;

  input {
    min-width: 0;
    width: 100%;
  }
`;

const Bang = styled.span`
  color: var(--text-dim);
  font-family: var(--font-mono);
`;

const CooldownField = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 0.8rem;

  input {
    width: 70px;
  }
`;

const Actions = styled.div`
  display: flex;
  gap: 6px;
`;
