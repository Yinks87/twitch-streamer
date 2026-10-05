import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import Thumbnail from '../components/Thumbnail';
import Button from '../components/Button';
import ViewModeToggle, { useViewMode } from '../components/ViewModeToggle';
import {
  VideoGrid,
  VideoTile,
  TileMedia,
  TileOverlay,
  TileBody,
  TileTitle,
  TileActions,
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
  const [viewMode, setViewMode] = useViewMode('playlist');
  const readyPlaylist = playlist?.filter((entry) => entry.status === 'ready');

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
        Einträge können einzeln deaktiviert werden. Die Reihenfolge der Playlist
        kann per Drag & Drop geändert werden. Bei inaktivem Shuffle wird die
        Playlist der Reihenfolge nach abgespielt.
      </Hint>
      <ViewBar>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </ViewBar>
      {(() => {
        const Container = viewMode === 'grid' ? VideoGrid : VideoList;
        return (
          <Container {...(viewMode === 'grid' ? { $maxHeight: '560px' } : {})}>
            {readyPlaylist.length === 0 && (
              <VideoListEmpty style={{ gridColumn: '1 / -1' }}>
                Keine Einträge. Lade ein Video hoch oder importiere einen VOD.
              </VideoListEmpty>
            )}
            {readyPlaylist.map((entry) => {
              const effectivelyEnabled = entry.enabled && !entry.needsCategory;
              const dragProps = {
                draggable: true,
                onDragStart: (event) => onDragStart(event, entry.id),
                onDragOver: (event) => onDragOver(event, entry.id),
                onDragLeave,
                onDrop: (event) => onDrop(event, entry.id),
                onDragEnd,
              };
              const thumbSrc = `/api/v1/thumbnails/${encodeURIComponent(entry.filename)}`;
              const badge = (
                <SourceBadge
                  $kind={entry.source}
                  $overlay={viewMode === 'grid'}
                >
                  {entry.source === 'vod'
                    ? 'VOD'
                    : entry.source === 'clip'
                      ? 'Clip'
                      : 'Upload'}
                </SourceBadge>
              );
              const statusSuffix = entry.status !== 'ready' && (
                <StatusSuffix>
                  {statusLabels[entry.status] ?? entry.status}
                </StatusSuffix>
              );
              const actions = (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => onToggle(entry.id, !entry.enabled)}
                    disabled={entry.needsCategory}
                    title={
                      entry.needsCategory
                        ? 'Kategorie fehlt – Transkript in der Mediathek vervollständigen, um zu aktivieren'
                        : effectivelyEnabled
                          ? 'Deaktivieren'
                          : 'Aktivieren'
                    }
                    style={{ fontSize: '0.75rem' }}
                  >
                    {effectivelyEnabled ? (
                      <span
                        style={{ color: 'var(--text-dim)' }}
                        className="material-symbols-outlined small"
                      >
                        mode_off_on
                      </span>
                    ) : (
                      <span className="material-symbols-outlined small">
                        play_circle
                      </span>
                    )}
                  </Button>
                  <StopGuardButton onClick={() => onRemove(entry.id)}>
                    <span className="material-symbols-outlined small">
                      delete
                    </span>
                  </StopGuardButton>
                </>
              );

              if (viewMode === 'grid') {
                return (
                  <PlaylistTile
                    key={entry.id}
                    {...dragProps}
                    $enabled={effectivelyEnabled}
                    $dragging={draggedId === entry.id}
                    $dragOver={dragOverId === entry.id}
                  >
                    <TileMedia>
                      <Thumbnail src={thumbSrc} alt="" fluid />
                      <TileOverlay>{badge}</TileOverlay>
                    </TileMedia>
                    <TileBody>
                      <TileTitle title={entry.title}>
                        {entry.title}
                        {statusSuffix}
                      </TileTitle>
                      <TileActions>{actions}</TileActions>
                    </TileBody>
                  </PlaylistTile>
                );
              }

              return (
                <PlaylistItem
                  key={entry.id}
                  {...dragProps}
                  $enabled={effectivelyEnabled}
                  $dragging={draggedId === entry.id}
                  $dragOver={dragOverId === entry.id}
                >
                  <Thumbnail src={thumbSrc} alt="" />
                  {badge}
                  <VideoListName>
                    {entry.title}
                    {statusSuffix}
                  </VideoListName>
                  {actions}
                </PlaylistItem>
              );
            })}
          </Container>
        );
      })()}
    </CollapsiblePanel>
  );
}

const Hint = styled.p`
  margin: 0 0 16px;
  color: var(--text-dim);
  font-size: 0.85rem;
`;

const ViewBar = styled.div`
  display: flex;
  margin-bottom: 10px;
`;

const PlaylistTile = styled(VideoTile)`
  opacity: ${({ $enabled }) => ($enabled ? 1 : 0.45)};
  cursor: ${({ $dragging }) => ($dragging ? 'grabbing' : 'grab')};
  outline: ${({ $dragOver }) =>
    $dragOver ? '2px solid var(--twitch, #9146ff)' : 'none'};
  outline-offset: -2px;
`;

const PlaylistItem = styled(VideoListItem)`
  opacity: ${({ $enabled }) => ($enabled ? 1 : 0.45)};
  align-items: center;
  cursor: ${({ $dragging }) => ($dragging ? 'grabbing' : 'grab')};
  outline: ${({ $dragOver }) =>
    $dragOver ? '2px solid var(--twitch, #9146ff)' : 'none'};
  outline-offset: -2px;
`;

const BADGE_COLORS = {
  vod: '#9147ff',
  clip: '#3b9eff',
};

const SourceBadge = styled.span`
  font-size: 0.7rem;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  background: ${({ $kind }) =>
    BADGE_COLORS[$kind] ? `${BADGE_COLORS[$kind]}22` : '#00000022'};
  color: ${({ $kind }) => BADGE_COLORS[$kind] ?? 'inherit'};
  flex-shrink: 0;
  ${({ $overlay }) =>
    $overlay && 'background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(2px);'}
`;

const StatusSuffix = styled.span`
  margin-left: 0.4rem;
  opacity: 0.65;
`;
