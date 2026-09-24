import { useCallback, useEffect, useState } from 'react';
import styled from '@emotion/styled';
import { api } from '../api';
import Button from '../components/Button';
import CollapsiblePanel from '../components/CollapsiblePanel';

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : 'Noch nicht gestartet';
}

export default function UpdatePanel({ setMessage }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getAppUpdateStatus());
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }, [setMessage]);

  useEffect(() => {
    loadStatus();
    const interval = window.setInterval(loadStatus, status?.running ? 2_000 : 15_000);
    return () => window.clearInterval(interval);
  }, [loadStatus, status?.running]);

  async function handleStartUpdate() {
    if (!window.confirm('Update starten? Der Dienst wird kurz neu gebaut und gestartet.')) return;
    setStarting(true);
    try {
      setStatus(await api.startAppUpdate());
      setMessage({ type: 'info', text: 'Update wurde gestartet.' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setStarting(false);
    }
  }

  function downloadLog() {
    const content = (status?.log || []).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `twitch-streamer-update-${Date.now()}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const hasLog = status?.log?.length > 0;
  const summary = status?.running
    ? 'Update läuft'
    : status?.exitCode === 0
      ? 'Letztes Update erfolgreich'
      : status?.exitCode != null
        ? 'Letztes Update fehlgeschlagen'
        : 'Bereit';

  return (
    <CollapsiblePanel storageKey="app-update" title="System-Update">
      <Description>
        Aktualisiert den Repository-Stand und erstellt die Container neu.
      </Description>
      <StatusRow>
        <StatusDot $running={status?.running} $failed={status?.exitCode > 0} />
        <div>
          <strong>{loading ? 'Status wird geladen' : summary}</strong>
          <StatusTime>{formatDate(status?.running ? status.startedAt : status?.finishedAt)}</StatusTime>
        </div>
      </StatusRow>
      <Actions>
        <Button
          variant="primary"
          type="button"
          onClick={handleStartUpdate}
          disabled={loading || starting || status?.running}
        >
          {starting ? 'Startet...' : status?.running ? 'Update läuft...' : 'Update starten'}
        </Button>
        <Button type="button" variant="ghost" onClick={downloadLog} disabled={!hasLog}>
          Log herunterladen
        </Button>
      </Actions>
      {hasLog && <LogOutput aria-label="Update-Log">{status.log.join('\n')}</LogOutput>}
    </CollapsiblePanel>
  );
}

const Description = styled.p`
  margin: 0;
  color: var(--text-dim);
  font-size: 0.875rem;
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
`;

const StatusDot = styled.span`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: ${({ $running, $failed }) => $running ? 'var(--signal)' : $failed ? 'var(--live)' : 'var(--ready)'};
`;

const StatusTime = styled.span`
  display: block;
  margin-top: 2px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 0.75rem;
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 18px;
`;

const LogOutput = styled.pre`
  max-height: 320px;
  margin: 18px 0 0;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #101311;
  color: #b9e8d5;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;