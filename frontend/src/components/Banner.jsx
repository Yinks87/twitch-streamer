import styled from '@emotion/styled';

// Shared inline status banner; pass type="error|info" (matches the former .banner classes).
const Banner = styled.div`
  padding: 10px 16px;
  border-radius: 4px;
  margin-bottom: 20px;
  font-size: 0.92rem;
  border: 1px solid var(--border);

  ${({ type }) =>
    type === 'error' &&
    `
      border-color: var(--live);
      color: #ffb4b6;
      background: rgba(229, 72, 77, 0.08);
    `}

  ${({ type }) =>
    type === 'info' &&
    `
      border-color: var(--ready);
      color: #b7e9d1;
      background: rgba(79, 174, 131, 0.08);
    `}
`;

export default Banner;
