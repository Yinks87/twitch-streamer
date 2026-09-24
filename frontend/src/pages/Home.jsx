import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { StatusProvider, useStatusContext } from '../context/StatusContext';
import StreamHeroPanel from '../panels/StreamHeroPanel';
import DownloadsPanelFile from '../panels/DownloadsPanel';
import MediaLibraryPanel from '../panels/MediaLibraryPanel';
import PlaylistPanel from '../panels/PlaylistPanel';
import LogsPanel from '../panels/LogsPanel';
import UploadDialog from '../components/UploadDialog';
import MetadataEditor from '../components/MetadataEditor';
import Button from '../components/Button';
import Banner from '../components/Banner';
import {
  Console,
  ConsoleHeader,
  Eyebrow,
  ConsoleClock,
  ConsoleGrid,
} from '../components/ConsoleLayout';

// ── Player page (/app) ────────────────────────────────────────────────────────

const SOURCE_LABELS = {
  all: 'Alle',
  uploads_only: 'Nur Uploads',
  vods_only: 'Nur VODs',
};
const VOD_STATUS_LABEL = {
  ready: '✓',
  downloading: '⏳ Download',
  error: '✗',
};

function formatUptime(startedAt) {
  if (!startedAt) return '00:00:00';
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
  );
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default function Home() {
  return (
    <StatusProvider>
      <PlayerPageContent />
    </StatusProvider>
  );
}

// Guarded destructive buttons — read stream status from context so the parent list doesn't
// need to hold/re-render on it.
function StopGuardButton({ onClick, children, title }) {
  const { status } = useStatusContext();
  return (
    <Button
      variant="ghost"
      danger
      onClick={onClick}
      disabled={status.running}
      title={status.running ? 'Stream läuft – zuerst stoppen' : title}
    >
      {children}
    </Button>
  );
}

// ── Active downloads panel — owns its own polling-derived data via context, so it
// never forces the rest of the page (e.g. the VOD browser) to re-render. ──────────
function PlayerPageContent() {
  const navigate = useNavigate();
  const [user, setUser] = useState(undefined); // undefined = loading, null = not logged in

  const [settings, setSettings] = useState({
    twitchServer: '',
    streamKey: '',
    playlistSource: 'all',
    loopPlaylist: true,
    videoBitrateKbps: 6000,
    audioBitrateKbps: 128,
    streamFps: 60,
    restartIntervalSeconds: 169200,
    restartDelaySeconds: 5,
  });
  const [videos, setVideos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadDialogFiles, setUploadDialogFiles] = useState(null); // null = closed
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const [editingVideo, setEditingVideo] = useState(null); // { name, transcript }

  const [libraryTab, setLibraryTab] = useState('uploads'); // 'uploads' | 'vods'
  const [vods, setVods] = useState([]);
  const [vodsLoading, setVodsLoading] = useState(false);
  const [vodsPagination, setVodsPagination] = useState(null);
  // null = eigene VODs; non-null string = alternativer Benutzername
  const [vodUserLogin, setVodUserLogin] = useState(null);
  const [vodSource, setVodSource] = useState('own'); // 'own' | 'other'
  const [altUsernameInput, setAltUsernameInput] = useState('');

  const [playlist, setPlaylist] = useState([]);
  const [draggedPlaylistId, setDraggedPlaylistId] = useState(null);
  const [dragOverPlaylistId, setDragOverPlaylistId] = useState(null);

  const [message, setMessage] = useState(null);

  const loadMe = useCallback(async () => {
    const { user } = await api.getMe();
    if (!user) {
      navigate('/', { replace: true });
      return;
    }
    setUser(user);
  }, [navigate]);

  const loadSettings = useCallback(async () => {
    const data = await api.getSettings();
    setSettings(data);
    // Restore saved alternate streamer selection.
    if (data.altStreamer) {
      setVodSource('other');
      setVodUserLogin(data.altStreamer);
      setAltUsernameInput(data.altStreamer);
    }
  }, []);

  const loadVideos = useCallback(async () => {
    const data = await api.getVideos();
    setVideos(data.videos);
  }, []);

  const loadPlaylist = useCallback(async () => {
    const data = await api.getPlaylist();
    setPlaylist(data.playlist);
  }, []);

  const loadVods = useCallback(
    async (after, silent = false) => {
      if (!silent) setVodsLoading(true);
      try {
        const data = await api.getVods(after, vodUserLogin ?? undefined);
        setVods((prev) => {
          if (!after) {
            // Silent background refreshes (e.g. while a download is pending) must only
            // update statuses of already-loaded VODs, never discard pages the user
            // scrolled/loaded further into via "Mehr laden".
            if (silent && prev.length > 0) {
              const byId = new Map(data.data.map((v) => [v.id, v]));
              return prev.map((v) =>
                byId.has(v.id) ? { ...v, ...byId.get(v.id) } : v,
              );
            }
            return data.data;
          }
          return [...prev, ...data.data];
        });
        if (!silent) setVodsPagination(data.pagination);
      } catch (err) {
        if (!silent) setMessage({ type: 'error', text: err.message });
      } finally {
        if (!silent) setVodsLoading(false);
      }
    },
    [vodUserLogin],
  );

  useEffect(() => {
    loadMe().catch(() => navigate('/', { replace: true }));
    loadSettings().catch((e) => setMessage({ type: 'error', text: e.message }));
    loadVideos().catch((e) => setMessage({ type: 'error', text: e.message }));
    loadPlaylist().catch(() => {});
  }, [loadMe, loadSettings, loadVideos, loadPlaylist, navigate]);

  useEffect(() => {
    if (libraryTab === 'vods' && user && vods.length === 0) loadVods();
  }, [libraryTab, user, vods.length, loadVods]);

  // Baseline dynamic refresh — keeps the Mediathek and Playlist views in sync with
  // changes made elsewhere (e.g. a transcript completed in another tab) without
  // requiring a manual reload or a user-triggered action.
  useEffect(() => {
    const id = setInterval(() => {
      loadVideos().catch(() => {});
      loadPlaylist().catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [loadVideos, loadPlaylist]);

  // Poll playlist and VODs faster while a VOD download is in progress.
  useEffect(() => {
    const hasPending = playlist.some((e) => e.status === 'downloading');
    if (!hasPending) return;
    const id = setInterval(() => {
      loadPlaylist().catch(() => {});
      if (user) loadVods(undefined, true).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [playlist, loadPlaylist, loadVods, user]);

  if (!user) return null;

  async function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    // Open the upload dialog to set category and titles before uploading.
    setUploadDialogFiles(Array.from(fileList));
  }

  async function doUpload(files, metaList) {
    setUploadDialogFiles(null);
    setUploading(true);
    setMessage(null);
    try {
      await api.uploadVideos(files, metaList);
      await Promise.all([loadVideos(), loadPlaylist()]);
      setMessage({
        type: 'info',
        text: `${files.length} Datei(en) hochgeladen.`,
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(name) {
    try {
      await api.deleteVideo(name);
      await Promise.all([loadVideos(), loadPlaylist()]);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function handleImportVod(vod) {
    try {
      await api.importVod(vod.id, vod.title);
      await Promise.all([loadPlaylist(), loadVods()]);
      setMessage({
        type: 'info',
        text: `Download von "${vod.title}" gestartet.`,
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function handleTogglePlaylistEntry(id, enabled) {
    try {
      await api.togglePlaylistEntry(id, enabled);
      await loadPlaylist();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function handleAddToPlaylist(filename) {
    try {
      await api.addToPlaylist(filename);
      await loadPlaylist();
      setMessage({ type: 'info', text: 'Video zur Playlist hinzugefügt.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function handleRemoveFromPlaylist(id) {
    try {
      await api.removeFromPlaylist(id);
      await loadPlaylist();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  function handlePlaylistDragStart(event, id) {
    setDraggedPlaylistId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(id));
  }

  function handlePlaylistDragEnd() {
    setDraggedPlaylistId(null);
    setDragOverPlaylistId(null);
  }

  async function handlePlaylistDrop(event, targetId) {
    event.preventDefault();
    const sourceId =
      draggedPlaylistId ?? Number(event.dataTransfer.getData('text/plain'));
    setDraggedPlaylistId(null);
    setDragOverPlaylistId(null);
    if (!sourceId || sourceId === targetId) return;

    const sourceIndex = playlist.findIndex((entry) => entry.id === sourceId);
    const targetIndex = playlist.findIndex((entry) => entry.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const reordered = [...playlist];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    setPlaylist(reordered);

    try {
      const data = await api.reorderPlaylist(
        reordered.map((entry) => entry.id),
      );
      if (Array.isArray(data.playlist)) setPlaylist(data.playlist);
    } catch (err) {
      await loadPlaylist();
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function handleLogout() {
    await api.logout();
    navigate('/', { replace: true });
  }

  const readyPlaylist = playlist.filter(
    (e) => e.status === 'ready' && e.enabled && !e.needsCategory,
  );

  return (
    <Console>
      {uploadDialogFiles && (
        <UploadDialog
          files={uploadDialogFiles}
          onClose={() => setUploadDialogFiles(null)}
          onUpload={doUpload}
        />
      )}
      {editingVideo && (
        <MetadataEditor
          filename={editingVideo.name}
          initialTranscript={editingVideo.transcript}
          onSave={() => Promise.all([loadVideos(), loadPlaylist()])}
          onClose={() => setEditingVideo(null)}
        />
      )}
      <ConsoleHeader>
        <div>
          <Eyebrow>Erstelle deine 24/7 Twitch Playlist</Eyebrow>
          <h1>Twitch 24/7 Player</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {user && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: '0.85rem',
                  opacity: 0.8,
                }}
              >
                <a
                  href={`https://www.twitch.tv/${user.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {user.profileImageUrl && (
                    <img
                      src={user.profileImageUrl}
                      alt=""
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        objectFit: 'cover',
                        verticalAlign: 'middle',
                        marginRight: '0.45rem',
                      }}
                    />
                  )}
                </a>
                <strong>{user.displayName}</strong>
              </span>
              <Button
                variant="ghost"
                onClick={handleLogout}
                style={{ fontSize: '0.8rem' }}
              >
                Logout
              </Button>
            </div>
          )}
          <Button
            as={Link}
            to="/settings"
            variant="ghost"
            style={{ fontSize: '0.8rem' }}
          >
            Einstellungen
          </Button>
        </div>
      </ConsoleHeader>

      {message && (
        <Banner type={message.type} role="status">
          {message.text}
          <button
            onClick={() => setMessage(null)}
            style={{
              marginLeft: '1rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              opacity: 0.7,
            }}
          >
            ✕
          </button>
        </Banner>
      )}

      <ConsoleGrid>
        <StreamHeroPanel
          settings={settings}
          setSettings={setSettings}
          readyPlaylist={readyPlaylist}
          setMessage={setMessage}
          userRole={user.role}
        />

        <MediaLibraryPanel
          libraryTab={libraryTab}
          setLibraryTab={setLibraryTab}
          videos={videos}
          uploading={uploading}
          dragOver={dragOver}
          setDragOver={setDragOver}
          fileInputRef={fileInputRef}
          handleFiles={handleFiles}
          playlist={playlist}
          onRefresh={() => Promise.all([loadVideos(), loadPlaylist()])}
          onDelete={handleDelete}
          onAddToPlaylist={handleAddToPlaylist}
          user={user}
          vodSource={vodSource}
          setVodSource={setVodSource}
          vodUserLogin={vodUserLogin}
          setVodUserLogin={setVodUserLogin}
          vods={vods}
          setVods={setVods}
          vodsLoading={vodsLoading}
          vodsPagination={vodsPagination}
          setVodsPagination={setVodsPagination}
          altUsernameInput={altUsernameInput}
          setAltUsernameInput={setAltUsernameInput}
          onImportVod={handleImportVod}
          onLoadMoreVods={loadVods}
        />
      </ConsoleGrid>

      {/* ── Active downloads ──────────────────────────────────────────────────── */}
      <DownloadsPanelFile onAborted={loadPlaylist} setMessage={setMessage} />

      {/* ── Playlist ─────────────────────────────────────────────────────────── */}
      <PlaylistPanel
        playlist={playlist}
        sourceLabel={SOURCE_LABELS[settings.playlistSource]}
        draggedId={draggedPlaylistId}
        dragOverId={dragOverPlaylistId}
        onDragStart={handlePlaylistDragStart}
        onDragOver={(event, id) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDragOverPlaylistId(id);
        }}
        onDragLeave={() => setDragOverPlaylistId(null)}
        onDrop={handlePlaylistDrop}
        onDragEnd={handlePlaylistDragEnd}
        onToggle={handleTogglePlaylistEntry}
        onRemove={handleRemoveFromPlaylist}
        StopGuardButton={StopGuardButton}
        statusLabels={VOD_STATUS_LABEL}
      />

      {/* ── Stream logs (admin only) ─────────────────────────────────────────── */}
      <LogsPanel userRole={user.role} setMessage={setMessage} />
    </Console>
  );
}
