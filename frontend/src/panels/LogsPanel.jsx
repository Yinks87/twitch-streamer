import { useCallback, useEffect, useState } from 'react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { api } from '../api';
import Button from '../components/Button';

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('de-DE');
}

// Admin-only panel for the ffmpeg session logs written by streamManager.js.
export default function LogsPanel({ userRole, setMessage }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openFilename, setOpenFilename] = useState(null);
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = userRole === 'admin' || userRole === 'broadcaster';

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getLogFiles();
      setLogs(data.logs || []);
    } catch (err) {
      setMessage?.({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, [setMessage]);

  useEffect(() => {
    if (isAdmin) loadLogs();
  }, [isAdmin, loadLogs]);

  if (!isAdmin) return null;

  async function handleView(filename) {
    if (openFilename === filename) {
      setOpenFilename(null);
      setContent('');
      return;
    }
    setOpenFilename(filename);
    setContentLoading(true);
    try {
      const data = await api.getLogFile(filename);
      setContent(data.content);
    } catch (err) {
      setMessage?.({ type: 'error', text: err.message });
    } finally {
      setContentLoading(false);
    }
  }

  const handleDelete = async (filename) => {
    setDeleting(true);
    try {
      const res = await api.deleteLogFile(filename);
      if (res.ok) {
        setLogs((prevLogs) =>
          prevLogs.filter((log) => log.filename !== filename),
        );
        if (openFilename === filename) {
          setOpenFilename(null);
          setContent('');
        }
        setDeleting(false);
      } else {
        setMessage?.({ type: 'error', text: 'Failed to delete log file.' });
      }
    } catch (err) {
      setMessage?.({ type: 'error', text: err.message });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <CollapsiblePanel storageKey="logs" title="Stream-Logs">
      <PanelHeader>
        <Button variant="ghost" onClick={loadLogs} disabled={loading}>
          <span className="material-symbols-outlined">autorenew</span>{' '}
          Aktualisieren
        </Button>
      </PanelHeader>
      {logs.length === 0 ? (
        <Empty>Keine Log-Dateien vorhanden.</Empty>
      ) : (
        <LogList>
          {logs.map((log) => (
            <LogItem key={log.filename}>
              <LogRow>
                <div>
                  <LogFilename>{log.filename}</LogFilename>
                  <LogMeta>
                    {formatSize(log.size)} · {formatDate(log.modifiedAt)}
                  </LogMeta>
                </div>
                <LogActions>
                  <Button
                    variant="ghost"
                    onClick={() => handleView(log.filename)}
                  >
                    {openFilename === log.filename ? 'Schließen' : 'Anzeigen'}
                  </Button>
                  <Button
                    as="a"
                    variant="ghost"
                    href={api.getLogFileDownloadUrl(log.filename)}
                    download={log.filename}
                  >
                    <span className="material-symbols-outlined">download</span>{' '}
                    Herunterladen
                  </Button>
                  <Button
                    danger
                    disabled={deleting}
                    onClick={() => handleDelete(log.filename)}
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </Button>
                </LogActions>
              </LogRow>
              {openFilename === log.filename && (
                <LogContent>{contentLoading ? 'Lädt…' : content}</LogContent>
              )}
            </LogItem>
          ))}
        </LogList>
      )}
    </CollapsiblePanel>
  );
}

const PanelHeader = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.75rem;
`;

const Empty = styled.p`
  margin: 0;
  color: var(--text-dim);
  font-size: 0.85rem;
`;

const LogList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
`;

const LogItem = styled.div`
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.65rem 0.85rem;
`;

const LogRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  flex-wrap: wrap;
`;

const LogFilename = styled.p`
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.85rem;
`;

const LogMeta = styled.p`
  margin: 2px 0 0;
  font-size: 0.72rem;
  color: var(--text-dim);
`;

const LogActions = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const LogContent = styled.pre`
  margin-top: 0.65rem;
  max-height: 320px;
  overflow-y: auto;
  background: #0f1013;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
`;
