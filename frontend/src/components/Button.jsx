import styled from '@emotion/styled';

// Shared button used across the app; pass variant="primary|login|start|stop|ghost"
// and/or danger to combine with the ghost look (matches the former .btn classes).
const Button = styled.button`
  border: 1px solid var(--border);
  background: var(--panel-raised);
  color: var(--text);
  padding: 9px 16px;
  border-radius: 4px;
  font-family: var(--font-display);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  ${({ variant }) =>
    variant === 'primary' &&
    `
      background: var(--signal);
      border-color: var(--signal);
      color: #1c1305;
    `}

  ${({ variant }) =>
    variant === 'login' &&
    `
      background: var(--twitch);
      border-color: var(--twitch);
      color: #1c1305;
    `}

  ${({ variant }) =>
    variant === 'start' &&
    `
      background: var(--ready);
      border-color: var(--ready);
      color: #08251a;
      padding: 12px 22px;
      font-size: 0.95rem;
    `}

  ${({ variant }) =>
    variant === 'stop' &&
    `
      background: var(--live);
      border-color: var(--live);
      color: #2b0607;
      padding: 12px 22px;
      font-size: 0.95rem;
    `}

  ${({ variant }) => variant === 'ghost' && `background: transparent;`}

  ${({ danger }) =>
    danger &&
    `
      color: #ff9fa1;
      border-color: rgba(229, 72, 77, 0.4);
    `}
`;

export default Button;
