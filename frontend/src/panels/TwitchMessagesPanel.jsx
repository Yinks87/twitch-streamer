import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { Input } from '../components/FormControls';
import Checkbox from '../components/Checkbox';
import Button from '../components/Button';

const TwitchMessagesPanel = ({
  settings,
  setSettings,
  onSave,
  isDirty,
  savingSettings,
}) => {
  return (
    <CollapsiblePanel storageKey="twitchMessages" title="Twitch Nachrichten">
      <Form onSubmit={onSave}>
        <Hint>Chatnachrichten ein-/ausschalten</Hint>
        <Checkbox
          onChange={(e) =>
            setSettings({
              ...settings,
              chatMessagesEnabled: e.target.checked,
              chatMessages: {
                ...settings.chatMessages,
              },
            })
          }
          checked={settings?.chatMessagesEnabled || false}
          label="Twitch Nachrichten aktivieren"
        />
        <Hint>
          Nachricht die beim Videowechsel im Twitch-Chat angezeigt wird.
        </Hint>
        <Input
          label="Aktuelles Video"
          value={settings?.chatMessages?.currentVideo || ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              chatMessages: {
                ...settings.chatMessages,
                currentVideo: e.target.value,
              },
            })
          }
        />
        <Hint>
          Nachricht die beim Neustart des Streams im Twitch-Chat angezeigt wird.
        </Hint>
        <Input
          label="Neustart Nachricht"
          value={settings?.chatMessages?.restartMessage || ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              chatMessages: {
                ...settings.chatMessages,
                restartMessage: e.target.value,
              },
            })
          }
        />
        <Hint>Angepinnte Nachricht ein-/ausschalten</Hint>
        <Checkbox
          onChange={(e) =>
            setSettings({
              ...settings,
              pinMessageEnabled: e.target.checked,
              chatMessages: {
                ...settings.chatMessages,
              },
            })
          }
          checked={settings?.pinMessageEnabled || false}
          label="Angepinnte Nachricht aktivieren"
        />

        <Hint>Nachricht die beim Neustart des Streams angepint wird.</Hint>
        <Input
          label="Angepinnte Nachricht"
          value={settings?.chatMessages?.pinMessage || ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              chatMessages: {
                ...settings.chatMessages,
                pinMessage: e.target.value,
              },
            })
          }
        />
        <Button
          variant="primary"
          type="submit"
          disabled={savingSettings || !isDirty}
        >
          {savingSettings ? 'Speichert…' : 'Speichern'}
        </Button>
      </Form>
    </CollapsiblePanel>
  );
};

export default TwitchMessagesPanel;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Hint = styled.p`
  margin: 0;
  color: var(--text-dim);
  font-size: 0.85rem;
`;
