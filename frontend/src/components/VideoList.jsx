import styled from '@emotion/styled';

// Shared list used by the Mediathek/VOD, Playlist, and Benutzerverwaltung panels
// (former .video-list* classes in App.css).
export const VideoList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 280px;
  overflow-y: auto;
`;

export const VideoListItem = styled.li`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);

  &:last-child {
    border-bottom: none;
  }
`;

export const VideoListName = styled.span`
  flex: 1;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const VideoListSize = styled.span`
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-dim);
`;

export const VideoListEmpty = styled.li`
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 8px 0;
`;

// -- Tile ("Kachel") view -----------------------------------------------------
export const VideoGrid = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  max-height: ${({ $maxHeight }) => $maxHeight ?? 'none'};
  overflow-y: ${({ $maxHeight }) => ($maxHeight ? 'auto' : 'visible')};
  padding-right: ${({ $maxHeight }) => ($maxHeight ? '4px' : '0')};
`;

export const VideoTile = styled.li`
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-raised);
  overflow: hidden;
`;

export const TileMedia = styled.div`
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #111;
`;

export const TileOverlay = styled.div`
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
`;

export const TileBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  flex: 1;
  min-width: 0;
`;

export const TileTitle = styled.span`
  font-family: var(--font-mono);
  font-size: 0.8rem;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
`;

export const TileMeta = styled.span`
  font-size: 0.72rem;
  color: var(--text-dim);
`;

export const TileActions = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: auto;
`;
