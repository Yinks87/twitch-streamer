import { useState } from 'react';
import styled from '@emotion/styled';

// Persisted list/tile ("Kachel") preference per area.
export function useViewMode(key, fallback = 'grid') {
  const storageKey = `twitch-streamer.viewMode.${key}`;
  const [mode, setMode] = useState(() => {
    const stored = window.localStorage.getItem(storageKey);
    return stored === 'list' || stored === 'grid' ? stored : fallback;
  });
  const update = (next) => {
    setMode(next);
    window.localStorage.setItem(storageKey, next);
  };
  return [mode, update];
}

export default function ViewModeToggle({ mode, onChange }) {
  return (
    <Group role="group" aria-label="Ansicht">
      <ToggleButton
        type="button"
        $active={mode === 'grid'}
        aria-pressed={mode === 'grid'}
        title="Kachelansicht"
        onClick={() => onChange('grid')}
      >
        <span className="material-symbols-outlined small">grid_view</span>
      </ToggleButton>
      <ToggleButton
        type="button"
        $active={mode === 'list'}
        aria-pressed={mode === 'list'}
        title="Listenansicht"
        onClick={() => onChange('list')}
      >
        <span className="material-symbols-outlined small">view_list</span>
      </ToggleButton>
    </Group>
  );
}

const Group = styled.div`
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-left: auto;
`;

const ToggleButton = styled.button`
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border: 0;
  cursor: pointer;
  color: ${({ $active }) => ($active ? '#1c1305' : 'var(--text-dim)')};
  background: ${({ $active }) => ($active ? 'var(--signal)' : 'transparent')};
`;
