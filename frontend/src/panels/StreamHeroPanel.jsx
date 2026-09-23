import React, { useEffect, useState } from 'react';
import { css, keyframes } from '@emotion/react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { useStatusContext } from '../context/StatusContext';
import { api } from '../api';
import Button from '../components/Button';
import { Select } from '../components/FormControls';

const SOURCE_LABELS = {
  all: 'Alle',
  uploads_only: 'Nur Uploads',
  vods_only: 'Nur VODs',
};

const pulse = keyframes`
  0%, 50% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45); }
  100% { box-shadow: 0 0 0 8px rgba(229, 72, 77, 0); }
`;

function formatUptime(startedAt, now) {
  if (!startedAt) return '00:00:00';
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remaining = String(seconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remaining}`;
}

function Uptime({ startedAt }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let timer;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    tick();
    return () => clearTimeout(timer);
  }, [startedAt]);

  return formatUptime(startedAt, now);
}

const StreamHeroPanel = ({
  settings,
  setSettings,
  readyPlaylist,
  setMessage,
  userRole,
}) => {
  const { status, setStatus } = useStatusContext();
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    setBusy(true);
    setMessage(null);
    try {
      const data = await api.startStream();
      setStatus(data);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const data = await api.stopStream();
      setStatus(data);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const lightState = status.running
    ? 'live'
    : readyPlaylist.length === 0
      ? 'idle'
      : 'ready';

  return (
    <CollapsiblePanel
      storageKey="stream"
      title="Streamsteuerung"
      variant="hero"
    >
      <SignalLight state={lightState} aria-hidden="true" />
      <HeroBody>
        <HeroState>
          {status.running
            ? 'ON AIR'
            : readyPlaylist.length === 0
              ? 'Keine Videos'
              : 'Bereit'}
        </HeroState>
        <HeroDetail>
          {status.running ? (
            <>
              Läuft seit <Uptime startedAt={status.startedAt} /> · PID{' '}
              {status.pid ?? '–'}
            </>
          ) : (
            `${readyPlaylist.length} Item(s) in der Playlist`
          )}
        </HeroDetail>
      </HeroBody>

      <HeroControls>
        <ModeToggle>
          <span>Quelle</span>
          <Select
            value={settings.playlistSource}
            onChange={(e) =>
              setSettings((s) => ({ ...s, playlistSource: e.target.value }))
            }
            disabled={status.running}
          >
            {Object.entries(SOURCE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </ModeToggle>

        <LoopToggle>
          <input
            type="checkbox"
            checked={!!settings.loopPlaylist}
            disabled={status.running}
            onChange={async (e) => {
              const loopPlaylist = e.target.checked;
              setSettings((s) => ({ ...s, loopPlaylist }));
              try {
                await api.saveSettings({ loopPlaylist });
              } catch (err) {
                setMessage({ type: 'error', text: err.message });
              }
            }}
          />
          <span>Loop</span>
        </LoopToggle>

        {status.running ? (
          <Button variant="stop" onClick={handleStop} disabled={busy}>
            Stream stoppen
          </Button>
        ) : (
          <Button
            variant="start"
            onClick={handleStart}
            disabled={
              busy ||
              readyPlaylist.length === 0 ||
              (userRole === 'broadcaster' && !settings.streamKey)
            }
          >
            Stream starten
          </Button>
        )}
      </HeroControls>

      {status.log && status.log.length > 0 && (
        <LogDrawer>
          <summary>ffmpeg-Log</summary>
          <pre>{status.log.join('\n')}</pre>
        </LogDrawer>
      )}
    </CollapsiblePanel>
  );
};

export default StreamHeroPanel;

const SignalLight = styled.div`
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ state }) =>
    state === 'live'
      ? 'var(--live)'
      : state === 'ready'
        ? 'var(--signal)'
        : 'var(--idle)'};
  box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45);
  ${({ state }) =>
    state === 'live' &&
    css`
      animation: ${pulse} 1.4s ease-in-out infinite;
    `};
`;

const HeroBody = styled.div`
  flex: 1 1 220px;
`;

const HeroState = styled.p`
  margin: 0;
  font-size: 1.3rem;
  font-weight: 600;
  letter-spacing: 0.02em;
`;

const HeroDetail = styled.p`
  margin: 2px 0 0;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.82rem;
`;

const HeroControls = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 14px;
  flex-wrap: wrap;
`;

const ModeToggle = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-dim);
  select {
    min-width: 260px;
  }
`;

const LoopToggle = styled(ModeToggle)`
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
`;

const LogDrawer = styled.details`
  flex-basis: 100%;
  margin-top: 6px;
  summary {
    cursor: pointer;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  pre {
    margin-top: 8px;
    max-height: 200px;
    overflow-y: auto;
    background: #0f1013;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-dim);
    white-space: pre-wrap;
  }
`;
