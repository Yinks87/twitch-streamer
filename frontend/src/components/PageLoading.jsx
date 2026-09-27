import CircularProgress from '@mui/material/CircularProgress';
import styled from '@emotion/styled';

export default function PageLoading({ page }) {
  return (
    <LoadingScreen role="status" aria-live="polite">
      <CircularProgress size={32} aria-label={`${page} wird geladen`} />
      <span>{page} wird geladen...</span>
    </LoadingScreen>
  );
}

const LoadingScreen = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: var(--text);
`;