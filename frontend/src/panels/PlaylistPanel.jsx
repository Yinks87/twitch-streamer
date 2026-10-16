import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import Thumbnail from '../components/Thumbnail';
import Button from '../components/Button';
import ViewModeToggle, { useViewMode } from '../components/ViewModeToggle';
import { useStatusContext } from '../context/StatusContext';
import {
  VideoGrid,
  VideoTile,
  TileMedia,
  TileOverlay,
  TileActions,
  VideoList,
  VideoListItem,
  VideoListName,
  VideoListEmpty,
  SourceBadge,
} from '../components/VideoList';
import { VideoInfo, VideoInfoRow } from '../components/VideoInfo';

export default function PlaylistPanel({
  playlist,
  videos,
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
  statusLabels,
  children,
}) {
  const [viewMode, setViewMode] = useViewMode('playlist');
  const { status } = useStatusContext();
  const readyPlaylist = playlist?.filter((entry) => entry.status === 'ready');
  const durationByName = new Map(
    (videos ?? []).map((video) => [video.name, video.duration]),
  );
  const currentVideo = status.running ? status.currentVideo : null;

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
              const isCurrent = currentVideo === entry.filename;
              const nowPlaying = isCurrent && (
                <NowPlaying
                  title={status.paused ? 'Pausiert' : 'Läuft gerade'}
                >
                  <span className="material-symbols-outlined small">
                    {status.paused ? 'pause' : 'play_arrow'}
                  </span>
                  {status.paused ? 'Pausiert' : 'Läuft'}
                </NowPlaying>
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
                  <Button
                    variant="ghost"
                    danger
                    onClick={() => onRemove(entry.id)}
                    disabled={isCurrent}
                    title={
                      isCurrent
                        ? 'Läuft gerade – kann nicht entfernt werden'
                        : 'Aus der Playlist entfernen'
                    }
                  >
                    <span className="material-symbols-outlined small">
                      delete
                    </span>
                  </Button>
                </>
              );

              if (viewMode === 'grid') {
                return (
                  <PlaylistTile
                    key={entry.id}
                    {...dragProps}
                    title={entry.title}
                    $enabled={effectivelyEnabled}
                    $current={isCurrent}
                    $dragging={draggedId === entry.id}
                    $dragOver={dragOverId === entry.id}
                  >
                    <TileMedia>
                      <Thumbnail src={thumbSrc} alt="" fluid />
                      {isCurrent && <TileOverlay>{nowPlaying}</TileOverlay>}
                    </TileMedia>
                    <PlaylistInfoRow>
                      <VideoInfo
                        active={effectivelyEnabled}
                        source={entry.source}
                        duration={durationByName.get(entry.filename)}
                        addedAt={entry.created_at}
                        transferredAt={
                          entry.source === 'upload'
                            ? null
                            : entry.twitch_created_at
                        }
                      />
                      <TileActions>{actions}</TileActions>
                    </PlaylistInfoRow>
                  </PlaylistTile>
                );
              }

              return (
                <PlaylistItem
                  key={entry.id}
                  {...dragProps}
                  $enabled={effectivelyEnabled}
                  $current={isCurrent}
                  $dragging={draggedId === entry.id}
                  $dragOver={dragOverId === entry.id}
                >
                  <Thumbnail src={thumbSrc} alt="" />
                  {badge}
                  <VideoListName>
                    {entry.title}
                    {statusSuffix}
                  </VideoListName>
                  {nowPlaying}
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

const PlaylistInfoRow = styled(VideoInfoRow)`
  flex-direction: column;
  align-items: stretch;
`;

const PlaylistTile = styled(VideoTile)`
  opacity: ${({ $enabled }) => ($enabled ? 1 : 0.45)};
  cursor: ${({ $dragging }) => ($dragging ? 'grabbing' : 'grab')};
  outline: ${({ $dragOver }) =>
    $dragOver ? '2px solid var(--twitch, #9146ff)' : 'none'};
  outline-offset: -2px;
  ${({ $current }) =>
    $current &&
    'border-color: var(--live); box-shadow: 0 0 0 1px var(--live);'}
`;

const PlaylistItem = styled(VideoListItem)`
  opacity: ${({ $enabled }) => ($enabled ? 1 : 0.45)};
  align-items: center;
  cursor: ${({ $dragging }) => ($dragging ? 'grabbing' : 'grab')};
  outline: ${({ $dragOver }) =>
    $dragOver ? '2px solid var(--twitch, #9146ff)' : 'none'};
  outline-offset: -2px;
  ${({ $current }) =>
    $current && 'box-shadow: inset 3px 0 0 var(--live); padding-left: 8px;'}
`;

const NowPlaying = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 0.1rem 0.4rem 0.1rem 0.2rem;
  border-radius: 3px;
  background: var(--live);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 600;

  .material-symbols-outlined {
    font-size: 14px;
  }
`;

const StatusSuffix = styled.span`
  margin-left: 0.4rem;
  opacity: 0.65;
`;
