import { useState } from 'react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import { useStatusContext } from '../context/StatusContext';
import { api } from '../api';
import Button from '../components/Button';

export default function DownloadsPanel({ onAborted, setMessage }) {
  const { downloads } = useStatusContext();
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const visible = downloads.filter(
    (download) => !hiddenIds.has(download.entryId),
  );
  if (visible.length === 0) return null;

  async function handleAbort(entryId) {
    try {
      await api.abortDownload(entryId);
      setHiddenIds((current) => new Set(current).add(entryId));
      await onAborted?.();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  }

  return (
    <CollapsiblePanel
      storageKey="downloads"
      title="Aktive Downloads"
      style={{ marginTop: '1rem' }}
    >
      {visible.map((download) => (
        <DownloadCard key={download.entryId}>
          <DownloadHeader>
            <div>
              <DownloadTitle>{download.title}</DownloadTitle>
              <DownloadFilename>{download.filename}</DownloadFilename>
            </div>
            <Button
              variant="ghost"
              danger
              onClick={() => handleAbort(download.entryId)}
            >
              Abbrechen
            </Button>
          </DownloadHeader>
          <ProgressTrack>
            <ProgressFill style={{ width: `${download.progress}%` }} />
          </ProgressTrack>
          <DownloadMeta>
            {download.progress.toFixed(1)}%
            {download.speed ? ` · ${download.speed}` : ''}
            {download.eta ? ` · ETA ${download.eta}` : ''}
          </DownloadMeta>
        </DownloadCard>
      ))}
    </CollapsiblePanel>
  );
}

const DownloadCard = styled.div`
  border: 1px solid #333;
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
`;
const DownloadHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  flex-wrap: wrap;
`;
const DownloadTitle = styled.p`
  margin: 0 0 0.25rem;
  font-weight: 600;
`;
const DownloadFilename = styled.p`
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.5;
  font-family: var(--font-mono);
`;
const ProgressTrack = styled.div`
  margin-top: 0.5rem;
  background: #333;
  border-radius: 3px;
  height: 6px;
  overflow: hidden;
`;
const ProgressFill = styled.div`
  height: 100%;
  background: #9147ff;
  transition: width 0.4s;
`;
const DownloadMeta = styled.p`
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  opacity: 0.55;
`;
