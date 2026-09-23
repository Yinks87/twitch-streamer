import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Button from '../components/Button';
import Banner from '../components/Banner';
import { Eyebrow } from '../components/ConsoleLayout';

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

  if (checking) return null;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.5rem',
        padding: '2rem',
      }}
    >
      <Eyebrow>
        Erstelle deine 24/7 Twitch Playlist und streame auf einen Twitch-Kanal
      </Eyebrow>
      <h1 style={{ margin: 0 }}>Twitch 24/7 Player</h1>
      <p style={{ opacity: 0.65, maxWidth: '360px', textAlign: 'center' }}>
        Melde dich mit deinem Twitch-Konto an.
      </p>

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
    </div>
  );
}
