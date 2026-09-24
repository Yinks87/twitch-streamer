import styled from '@emotion/styled';

// Shared page shell used by Home and Settings (and the eyebrow/clock bits by Login too).
export const Console = styled.div`
  max-width: 880px;
  margin: 0 auto;
  padding: 32px 20px 80px;
`;

export const ConsoleHeader = styled.header`
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 20px;
  margin-bottom: 24px;

  h1 {
    margin: 0;
    font-size: 1.9rem;
    font-weight: 600;
  }
`;

export const Eyebrow = styled.p`
  margin: 0 0 4px;
  color: var(--text-dim);
  font-size: 0.8rem;
  letter-spacing: 0.02em;
`;

export const ConsoleClock = styled.div`
  font-family: var(--font-mono);
  font-size: 1.4rem;
  color: var(--text-dim);
  letter-spacing: 0.04em;
`;

export const ConsoleGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
`;
