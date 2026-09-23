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
