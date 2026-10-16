import styled from '@emotion/styled';
import { SourceBadge } from './VideoList';

export const SOURCE_LABELS = { upload: 'Upload', vod: 'VOD', clip: 'Clip' };

// playlist.created_at is SQLite's "YYYY-MM-DD HH:MM:SS" in UTC without a zone marker.
export function formatDateTime(value) {
  if (!value) return '-';
  const text = String(value);
  const date = new Date(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text,
  );
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export function formatVideoLength(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const StatusDot = styled.span`
  width: ${({ $active }) => ($active ? '12px' : '10px')};
  height: ${({ $active }) => ($active ? '12px' : '10px')};
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $active }) =>
    $active ? 'var(--color-success, #4caf50)' : '#666'};
  box-shadow: ${({ $active }) =>
    $active
      ? '0 0 0 3px rgba(76,175,80,.24), 0 0 8px rgba(76,175,80,.35)'
      : 'none'};
  transition:
    width 0.15s ease,
    height 0.15s ease,
    box-shadow 0.15s ease;
`;

const StatusValue = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
`;

// Info block shared by the Mediathek and Playlist tiles.
export function VideoInfo({
  active,
  source,
  duration,
  addedAt,
  transferredAt,
}) {
  return (
    <InfoList>
      <dt>Status</dt>
      <dd>
        <StatusValue>
          <StatusDot $active={active} />
          {active ? 'Aktiv' : 'Inaktiv'}
        </StatusValue>
      </dd>
      <dt>Typ</dt>
      <dd>
        <SourceBadge $kind={source}>
          {SOURCE_LABELS[source] || 'Upload'}
        </SourceBadge>
      </dd>
      <dt>Länge</dt>
      <dd>{formatVideoLength(duration)}</dd>
      <dt>Hinzugefügt</dt>
      <dd>{formatDateTime(addedAt)}</dd>
      <dt>Übertragen am</dt>
      <dd>{formatDateTime(transferredAt)}</dd>
    </InfoList>
  );
}

// Info on the left, controls (e.g. the "?" or the action buttons) bottom right.
export const VideoInfoRow = styled.div`
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 8px;
  margin-top: 8px;
`;

const InfoList = styled.dl`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 3px 8px;
  margin: 0;
  min-width: 0;
  font-size: 0.72rem;

  dt {
    color: var(--text-dim);
  }

  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
`;
