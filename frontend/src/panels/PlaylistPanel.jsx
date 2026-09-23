import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import Thumbnail from '../components/Thumbnail';
import Button from '../components/Button';
import {
  VideoList,
  VideoListItem,
  VideoListName,
  VideoListEmpty,
} from '../components/VideoList';

export default function PlaylistPanel({
  playlist,
  sourceLabel,
  draggedId,
  dragOverId,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onToggle,
  onRemove,
  StopGuardButton,
  statusLabels,
  children,
}) {
  if (!playlist)
    return (
      <CollapsiblePanel
        storageKey="playlist"
        title="Playlist"
        style={{ marginTop: '1rem' }}
      >
        {children}
      </CollapsiblePanel>
    );
  return (
    <CollapsiblePanel
      storageKey="playlist"
      title="Playlist"
      style={{ marginTop: '1rem' }}
    >
      <Hint>
        Aktive Playlist basierend auf der Quellenauswahl „{sourceLabel}".
        Einträge können einzeln deaktiviert werden.
      </Hint>
      <VideoList>
        {playlist.length === 0 && (
          <VideoListEmpty>
            Keine Einträge. Lade ein Video hoch oder importiere einen VOD.
          </VideoListEmpty>
        )}
        {playlist.map((entry) => {
          const effectivelyEnabled = entry.enabled && !entry.needsCategory;
          return (
            <PlaylistItem
              key={entry.id}
              draggable
              onDragStart={(event) => onDragStart(event, entry.id)}
              onDragOver={(event) => onDragOver(event, entry.id)}
              onDragLeave={onDragLeave}
              onDrop={(event) => onDrop(event, entry.id)}
              onDragEnd={onDragEnd}
              $enabled={effectivelyEnabled}
              $dragging={draggedId === entry.id}
              $dragOver={dragOverId === entry.id}
            >
              <Thumbnail
                src={`/api/v1/thumbnails/${encodeURIComponent(entry.filename)}`}
                alt=""
              />
              <SourceBadge $vod={entry.source === 'vod'}>
                {entry.source === 'vod' ? 'VOD' : 'Upload'}
              </SourceBadge>
              <VideoListName>
                {entry.title}
                {entry.status !== 'ready' && (
                  <StatusSuffix>
                    {statusLabels[entry.status] ?? entry.status}
                  </StatusSuffix>
                )}
              </VideoListName>
              <Button
                variant="ghost"
                onClick={() => onToggle(entry.id, !entry.enabled)}
                disabled={entry.needsCategory}
                title={
                  entry.needsCategory
                    ? 'Kategorie fehlt – Transkript in der Mediathek vervollständigen, um zu aktivieren'
                    : undefined
                }
                style={{ fontSize: '0.75rem' }}
              >
                {effectivelyEnabled ? 'Deaktivieren' : 'Aktivieren'}
              </Button>
              <StopGuardButton onClick={() => onRemove(entry.id)}>
                Entfernen
              </StopGuardButton>
            </PlaylistItem>
          );
        })}
      </VideoList>
    </CollapsiblePanel>
  );
}

const Hint = styled.p`
  margin: 0 0 16px;
  color: var(--text-dim);
  font-size: 0.85rem;
`;

const PlaylistItem = styled(VideoListItem)`
  opacity: ${({ $enabled }) => ($enabled ? 1 : 0.45)};
  align-items: center;
  cursor: ${({ $dragging }) => ($dragging ? 'grabbing' : 'grab')};
  outline: ${({ $dragOver }) =>
    $dragOver ? '2px solid var(--twitch, #9146ff)' : 'none'};
  outline-offset: -2px;
`;

const SourceBadge = styled.span`
  font-size: 0.7rem;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  background: ${({ $vod }) => ($vod ? '#9147ff22' : '#00000022')};
  color: ${({ $vod }) => ($vod ? '#9147ff' : 'inherit')};
  flex-shrink: 0;
`;

const StatusSuffix = styled.span`
  margin-left: 0.4rem;
  opacity: 0.65;
`;

