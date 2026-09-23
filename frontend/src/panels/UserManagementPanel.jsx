import { useCallback, useEffect, useState } from 'react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { api } from '../api';
import Button from '../components/Button';
import { Input } from '../components/FormControls';
import {
  VideoList,
  VideoListItem,
  VideoListName,
} from '../components/VideoList';
import { Chip, Avatar } from '@mui/material';

export default function UserManagementPanel({ setMessage }) {
  const [managers, setManagers] = useState([]);
  const [login, setLogin] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadManagers = useCallback(async () => {
    try {
      const data = await api.getManagers();
      setManagers(data.managers || []);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }, [setMessage]);

  useEffect(() => {
    loadManagers();
  }, [loadManagers]);

  async function handleAdd(event) {
    event.preventDefault();
    const value = login.trim();
    if (!value) return;
    setSaving(true);
    try {
      const data = await api.addManager(value);
      setManagers((current) => [...current, data.manager]);
      setLogin('');
      setMessage({
        type: 'info',
        text: `${data.manager.display_name} wurde als Manager hinzugefügt.`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(manager) {
    try {
      await api.removeManager(manager.id);
      setManagers((current) =>
        current.filter((item) => item.id !== manager.id),
      );
      setMessage({
        type: 'info',
        text: `${manager.display_name} wurde entfernt.`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  }

  return (
    <CollapsiblePanel storageKey="user-management" title="Benutzerverwaltung">
      <Hint>
        Manager können sich anmelden und Stream-Einstellungen ändern, aber den
        Stream-Key nicht sehen.
      </Hint>
      <AddForm onSubmit={handleAdd}>
        <Input
          type="text"
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          placeholder="Twitch-Login des Managers"
          autoComplete="off"
        />
        <Button
          variant="primary"
          type="submit"
          disabled={saving || !login.trim()}
        >
          {saving ? 'Prüft…' : 'Manager hinzufügen'}
        </Button>
      </AddForm>
      {loading ? (
        <Hint>Lädt…</Hint>
      ) : managers.length === 0 ? (
        <Hint>Noch keine Manager hinzugefügt.</Hint>
      ) : (
        <ManagerList>
          {managers.map((manager) => (
            <Chip
              key={manager.id}
              avatar={<Avatar src={manager.profile_image_url} alt="" />}
              label={manager.display_name}
              onDelete={() => handleRemove(manager)}
              sx={{
                backgroundColor: 'var(--panel-raised)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                '& .MuiChip-deleteIcon': {
                  color: 'var(--error-light)',
                  transition: '0.1s ease-in-out',
                  '&:hover': {
                    color: 'var(--error-main)',
                  },
                },
              }}
            />
          ))}
        </ManagerList>
      )}
    </CollapsiblePanel>
  );
}

const Hint = styled.p`
  margin: 0 0 16px;
  color: var(--text-dim);
  font-size: 0.85rem;
`;
const AddForm = styled.form`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  input {
    flex: 1;
  }
`;

const ManagerList = styled.div`
  display: flex;
  gap: 0.5rem;
`;
