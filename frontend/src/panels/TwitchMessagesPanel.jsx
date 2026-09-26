import React, { useState } from 'react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { Input } from '../components/FormControls';
import Checkbox from '../components/Checkbox';
import { useEffect } from 'react';
import { api } from '../api';
import Button from '../components/Button';

const defaultMessages = {
  currentVideo: 'Aktueller Titel: "${title}" in der Kategorie: "${category}"',
  restartMessage: 'Stream wird in ${duration}s neu gestartet',
};

const TwitchMessagesPanel = () => {
  const [settings, setSettings] = useState({});
  const [messages, setMessages] = useState(defaultMessages);

  useEffect(() => {
    const fetchSettings = async () => {
      const storedSettings = await api.getSettings();
      setSettings(storedSettings);
      setMessages({
        chatMessagesEnabled: storedSettings?.chatMessagesEnabled || true,
        currentVideo:
          storedSettings?.chatMessages?.currentVideo ||
          defaultMessages.currentVideo,
        restartMessage:
          storedSettings?.chatMessages?.restartMessage ||
          defaultMessages.restartMessage,
      });
    };
    fetchSettings();
  }, []);

  const onSave = async (e) => {
    e.preventDefault();
    setSettings({
      ...settings,
      chatMessages: {
        currentVideo: messages.currentVideo,
        restartMessage: messages.restartMessage,
      },
    });

    await api.saveSettings({
      ...settings,
      chatMessages: {
        currentVideo: messages.currentVideo,
        restartMessage: messages.restartMessage,
      },
    });
  };

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
          value={messages.currentVideo}
          onChange={(e) =>
            setMessages({ ...messages, currentVideo: e.target.value })
          }
        />
        <Hint>
          Nachricht die beim Neustart des Streams im Twitch-Chat angezeigt wird.
        </Hint>
        <Input
          label="Neustart Nachricht"
          value={messages.restartMessage}
          onChange={(e) =>
            setMessages({ ...messages, restartMessage: e.target.value })
          }
        />
        <Button variant="primary" type="submit">
          Speichern
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
