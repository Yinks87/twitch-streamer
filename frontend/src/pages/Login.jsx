import { useEffect, useState } from 'react';
import styled from '@emotion/styled';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import Button from '../components/Button';
import Banner from '../components/Banner';
import { Eyebrow } from '../components/ConsoleLayout';
import PageLoading from '../components/PageLoading';
import icon from '../assets/icon.png';

// ── Login page (/) ────────────────────────────────────────────────────────────
export default function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('error')) {
      setError(decodeURIComponent(params.get('error')));
      window.history.replaceState({}, '', '/');
    }
    // Already logged in → go straight to the player
    api
      .getMe()
      .then(({ user }) => {
        if (user) navigate('/app', { replace: true });
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [navigate]);

  if (checking) return <PageLoading page="Login-Seite" />;

  return (
    <Container>
      <IconImage src={icon} alt="Twitch 24/7 Player Icon" />
      <Eyebrow>
        Erstelle deine 24/7 Twitch Playlist und streame auf einen Twitch-Kanal
      </Eyebrow>
      {error && (
        <Banner type="error" role="alert">
          {error}
        </Banner>
      )}

      <Button
        as="a"
        href={api.loginUrl}
        variant="login"
        style={{
          textDecoration: 'none',
          fontSize: '1rem',
          padding: '0.75rem 2rem',
        }}
      >
        Mit Twitch anmelden
      </Button>
    </Container>
  );
}

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  padding: 2rem;
  /* position: relative; */
`;

const IconImage = styled.img`
  /* position: absolute; */
  width: 240px;
  height: 240px;
  border-radius: 25px;
  z-index: -1;
`;
