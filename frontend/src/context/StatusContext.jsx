import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api';

// Holds stream status + active-download polling in one place so that only the
// components which actually read this data re-render every 1.5-3s tick —
// instead of the whole page (which previously reset VOD browsing/scroll state).
const StatusContext = createContext(null);

export function StatusProvider({ children }) {
  const [status, setStatus] = useState({ running: false, startedAt: null, log: [] });
  const [downloads, setDownloads] = useState([]);

  const refreshStatus = useCallback(async () => {
    const data = await api.getStatus();
    setStatus(data);
    return data;
  }, []);

  // Poll stream status
  useEffect(() => {
    const id = setInterval(() => refreshStatus().catch(() => {}), 3000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Always-on download progress poll — stable interval, never restarts on progress changes.
  useEffect(() => {
    const id = setInterval(() => {
      api
        .getDownloads()
        .then((d) =>
          setDownloads((prev) =>
            prev.length === 0 && d.downloads.length === 0 ? prev : d.downloads,
          ),
        )
        .catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, []);

  return (
    <StatusContext.Provider value={{ status, setStatus, downloads, refreshStatus }}>
      {children}
    </StatusContext.Provider>
  );
}

export function useStatusContext() {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error('useStatusContext must be used within a StatusProvider');
  return ctx;
}
