import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import DestinationPanel from '../panels/DestinationPanel';
import UserManagementPanelFile from '../panels/UserManagementPanel';
import Button from '../components/Button';
import Banner from '../components/Banner';
import {
  Console,
  ConsoleHeader,
  Eyebrow,
  ConsoleGrid,
} from '../components/ConsoleLayout';
import LogsPanel from '../panels/LogsPanel';
import TwitchMessagesPanel from '../panels/TwitchMessagesPanel';
import { isDirtyCheck } from '../utils/isDirtyCheck';
import PageLoading from '../components/PageLoading';

const INGEST_PRESETS = [
  { label: 'Automatisch (live.twitch.tv)', value: 'rtmp://live.twitch.tv/app' },
  { label: 'Frankfurt', value: 'rtmp://fra02.contribute.live-video.net/app' },
  { label: 'Prag', value: 'rtmp://prg02.contribute.live-video.net/app' },
  { label: 'Wien', value: 'rtmp://vie02.contribute.live-video.net/app' },
  { label: 'Amsterdam', value: 'rtmp://ams03.contribute.live-video.net/app' },
  { label: 'Benutzerdefiniert', value: 'custom' },
];

function getDestinationSettings(settings, twitchServer) {
  return {
    twitchServer,
    streamKey: settings.streamKey,
    videoBitrateKbps: settings.videoBitrateKbps,
    audioBitrateKbps: settings.audioBitrateKbps,
    streamFps: settings.streamFps,
    restartIntervalSeconds: settings.restartIntervalSeconds,
    restartDelaySeconds: settings.restartDelaySeconds,
  };
}

function getTwitchMessageSettings(settings) {
  return {
    chatMessagesEnabled: settings.chatMessagesEnabled,
    chatMessages: {
      currentVideo: settings.chatMessages?.currentVideo ?? '',
      restartMessage: settings.chatMessages?.restartMessage ?? '',
    },
  };
}

// ── Settings page (/settings) — Sendeziel & Benutzerverwaltung ────────────────
export default function Settings() {
  const navigate = useNavigate();
  const [user, setUser] = useState(undefined); // undefined = loading, null = not logged in
  const [pageLoading, setPageLoading] = useState(true);

  const [settings, setSettings] = useState({
    twitchServer: '',
    streamKey: '',
    playlistSource: 'all',
    loopPlaylist: true,
    videoBitrateKbps: 6000,
    audioBitrateKbps: 128,
    streamFps: 60,
    restartIntervalSeconds: 169200,
    restartDelaySeconds: 5,
    chatMessagesEnabled: true,
    chatMessages: {
      currentVideo:
        'Aktueller Titel: "${title}" in der Kategorie: "${category}"',
      restartMessage: 'Stream wird in ${duration}s neu gestartet',
    },
  });
  const [initialSettings, setInitialSettings] = useState(null);
  const [ingestChoice, setIngestChoice] = useState('rtmp://live.twitch.tv/app');
  const [customServer, setCustomServer] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [message, setMessage] = useState(null);

  const loadMe = useCallback(async () => {
    const { user } = await api.getMe();
    if (!user) {
      navigate('/', { replace: true });
      return;
    }
    setUser(user);
  }, [navigate]);

  const loadSettings = useCallback(async () => {
    const data = await api.getSettings();
    setSettings(data);
    setInitialSettings(data);
    const known = INGEST_PRESETS.find((p) => p.value === data.twitchServer);
    setIngestChoice(known ? known.value : 'custom');
    if (!known) setCustomServer(data.twitchServer);
  }, []);

  useEffect(() => {
    Promise.all([
      loadMe().catch(() => navigate('/', { replace: true })),
      loadSettings().catch((e) => setMessage({ type: 'error', text: e.message })),
    ]).finally(() => setPageLoading(false));
  }, [loadMe, loadSettings, navigate]);

  if (pageLoading) return <PageLoading page="Einstellungsseite" />;
  if (!user) return null;

  const effectiveServer =
    ingestChoice === 'custom' ? customServer : ingestChoice;
  const isDestinationDirty =
    initialSettings !== null &&
    isDirtyCheck(
      getDestinationSettings(settings, effectiveServer),
      getDestinationSettings(initialSettings, initialSettings.twitchServer),
    );
  const isTwitchMessagesDirty =
    initialSettings !== null &&
    isDirtyCheck(
      getTwitchMessageSettings(settings),
      getTwitchMessageSettings(initialSettings),
    );

  async function handleSaveSettings(e) {
    e.preventDefault();
    setSavingSettings(true);
    setMessage(null);
    try {
      const payload = {
        twitchServer: effectiveServer,
        playlistSource: settings.playlistSource,
        loopPlaylist: settings.loopPlaylist,
        videoBitrateKbps: Number(settings.videoBitrateKbps),
        audioBitrateKbps: Number(settings.audioBitrateKbps),
        streamFps: Number(settings.streamFps),
        restartIntervalSeconds: Number(settings.restartIntervalSeconds),
        restartDelaySeconds: Number(settings.restartDelaySeconds),
        chatMessagesEnabled: settings.chatMessagesEnabled,
        chatMessages: {
          currentVideo: settings.chatMessages.currentVideo,
          restartMessage: settings.chatMessages.restartMessage,
        },
      };
      if (user.role === 'broadcaster' || user.role === 'admin')
        payload.streamKey = settings.streamKey;
      const saved = await api.saveSettings(payload);
      setSettings(saved);
      setInitialSettings(saved);
      setMessage({ type: 'info', text: 'Einstellungen gespeichert.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <Console>
      <ConsoleHeader>
        <div>
          <Eyebrow>Twitch 24/7 Player</Eyebrow>
          <h1>Einstellungen</h1>
        </div>
        <Button as={Link} to="/app" variant="ghost">
          <span className="material-symbols-outlined small">arrow_back</span>{' '}
          Zurück
        </Button>
      </ConsoleHeader>

      {message && (
        <Banner type={message.type} role="status">
          {message.text}
          <button
            onClick={() => setMessage(null)}
            style={{
              marginLeft: '1rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              opacity: 0.7,
            }}
          >
            ✕
          </button>
        </Banner>
      )}

      <ConsoleGrid>
        <DestinationPanel
          settings={settings}
          setSettings={setSettings}
          user={user}
          ingestChoice={ingestChoice}
          setIngestChoice={setIngestChoice}
          customServer={customServer}
          setCustomServer={setCustomServer}
          showKey={showKey}
          setShowKey={setShowKey}
          savingSettings={savingSettings}
          isDirty={isDestinationDirty}
          onSave={handleSaveSettings}
        />

        {(user.role === 'broadcaster' || user.role === 'admin') && (
          <UserManagementPanelFile setMessage={setMessage} />
        )}
        {(user.role === 'broadcaster' || user.role === 'admin') && (
          <TwitchMessagesPanel
            settings={settings}
            setSettings={setSettings}
            onSave={handleSaveSettings}
            isDirty={isTwitchMessagesDirty}
            savingSettings={savingSettings}
          />
        )}
        {/* ── Stream logs (admin only) ─────────────────────────────────────────── */}
        <LogsPanel
          userRole={user.role}
          setMessage={setMessage}
        />
      </ConsoleGrid>
    </Console>
  );
}
