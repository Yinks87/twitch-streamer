import React, { useState, useEffect } from 'react';
import styled from '@emotion/styled';

const CollapsiblePanel = ({
  storageKey,
  title,
  variant = 'default',
  style,
  children,
}) => {
  const localStorageKey = `twitch-streamer.panel.${storageKey}`;
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(localStorageKey) === 'collapsed',
  );

  useEffect(() => {
    window.localStorage.setItem(
      localStorageKey,
      collapsed ? 'collapsed' : 'expanded',
    );
  }, [collapsed, localStorageKey]);

  return (
    <Panel $hero={variant === 'hero'} style={style}>
      <PanelTitle>
        <PanelToggle
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>{title}</span>
          <PanelToggleIcon aria-hidden="true">
            <span
              style={{
                transition: 'transform 0.1s ease-in-out',
                transform: collapsed ? 'rotate(90deg)' : 'rotate(270deg)',
              }}
              className="material-symbols-outlined small"
            >
              arrow_forward_ios
            </span>
          </PanelToggleIcon>
        </PanelToggle>
      </PanelTitle>
      {!collapsed && (
        <PanelContent $hero={variant === 'hero'}>{children}</PanelContent>
      )}
    </Panel>
  );
};

export default CollapsiblePanel;

const Panel = styled.section`
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 22px 24px;
  ${({ $hero }) => $hero && 'position: relative; padding: 26px 28px;'}
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
`;

const PanelToggle = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
`;

const PanelToggleIcon = styled.span`
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 1.2rem;
  font-weight: 400;
`;

const PanelContent = styled.div`
  margin-top: 16px;
  ${({ $hero }) =>
    $hero &&
    `
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 18px;
  `}
`;
