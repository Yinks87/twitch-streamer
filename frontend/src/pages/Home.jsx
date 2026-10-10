import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useStatusContext } from '../context/StatusContext';
import { useAlert } from '../context/AlertContext';
import StreamHeroPanel from '../panels/StreamHeroPanel';
import DownloadsPanelFile from '../panels/DownloadsPanel';
import MediaLibraryPanel from '../panels/MediaLibraryPanel';
import PlaylistPanel from '../panels/PlaylistPanel';
import UploadDialog from '../components/UploadDialog';
import MetadataEditor from '../components/MetadataEditor';
import Button from '../components/Button';
import {
  Console,
  ConsoleHeader,
  Eyebrow,
  ConsoleGrid,
} from '../components/ConsoleLayout';
import PageLoading from '../components/PageLoading';

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

const PRIVILEGED_ROLES = ['admin', 'broadcaster'];
const PLAYLIST_CHANGE_NOTICE_KEY = 'twitch-streamer.playlist-change-pending';
const STREAM_PLAYLIST_SIGNATURE_KEY =
  'twitch-streamer.stream-playlist-signature';

function getPlaylistSignature(playlist) {
  return playlist.map((entry) => entry.id).join(',');
}

export default function Home() {
  return <PlayerPageContent />;
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
  const [pageLoading, setPageLoading] = useState(true);

  const { showAlert } = useAlert();

  const [settings, setSettings] = useState({
    twitchServer: '',
    streamKey: '',
    playlistSource: 'all',
    loopPlaylist: true,
    shuffleMode: true,
    videoBitrateKbps: 6000,
    audioBitrateKbps: 128,
    streamFps: 60,
    restartIntervalSeconds: 169200,
    restartDelaySeconds: 5,
  });
  const [videos, setVideos] = useState([]);
  const [storage, setStorage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadDialogFiles, setUploadDialogFiles] = useState(null); // null = closed
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const [editingVideo, setEditingVideo] = useState(null); // { name, transcript }

  const [libraryTab, setLibraryTab] = useState('videos'); // 'videos' | 'uploads' | 'vods' | 'clips'
  const [vods, setVods] = useState([]);
  const [vodsLoading, setVodsLoading] = useState(false);
  const [vodsPagination, setVodsPagination] = useState(null);
  // null = eigene VODs; non-null string = alternativer Benutzername
  const [vodUserLogin, setVodUserLogin] = useState(null);
  const [vodSource, setVodSource] = useState('own'); // 'own' | 'other'
  const [altUsernameInput, setAltUsernameInput] = useState('');

  const [clips, setClips] = useState([]);
  const [clipsLoading, setClipsLoading] = useState(false);
  const [clipsPagination, setClipsPagination] = useState(null);
  const [clipSortBy, setClipSortBy] = useState('date'); // 'date' | 'views'
  const [clipCreatorFilter, setClipCreatorFilter] = useState('');
  const [clipDateFrom, setClipDateFrom] = useState('');
  const [clipDateTo, setClipDateTo] = useState('');

  const [playlist, setPlaylist] = useState([]);
  const [playlistChangePending, setPlaylistChangePending] = useState(
    () => window.localStorage.getItem(PLAYLIST_CHANGE_NOTICE_KEY) === 'true',
  );
  const playlistRequestRef = useRef(0);
  const [draggedPlaylistId, setDraggedPlaylistId] = useState(null);
  const [dragOverPlaylistId, setDragOverPlaylistId] = useState(null);

  const [deleteConfirmation, setDeleteConfirmation] = useState(null);

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
    setStorage(data.storage);
  }, []);

  const loadPlaylist = useCallback(async () => {
    const requestId = ++playlistRequestRef.current;
    const data = await api.getPlaylist();
    if (requestId !== playlistRequestRef.current) return;
    const signature = getPlaylistSignature(data.playlist);
    let streamPlaylistSignature = window.localStorage.getItem(
      STREAM_PLAYLIST_SIGNATURE_KEY,
    );
    if (streamPlaylistSignature === null) {
      streamPlaylistSignature = signature;
      window.localStorage.setItem(
        STREAM_PLAYLIST_SIGNATURE_KEY,
        streamPlaylistSignature,
      );
    }
    const changePending = signature !== streamPlaylistSignature;
    window.localStorage.setItem(
      PLAYLIST_CHANGE_NOTICE_KEY,
      String(changePending),
    );
    setPlaylistChangePending(changePending);
    setPlaylist(data.playlist);
  }, []);

  function handleStreamStarted() {
    playlistRequestRef.current += 1;
    const signature = getPlaylistSignature(playlist);
    window.localStorage.setItem(STREAM_PLAYLIST_SIGNATURE_KEY, signature);
    window.localStorage.setItem(PLAYLIST_CHANGE_NOTICE_KEY, 'false');
    setPlaylistChangePending(false);
  }

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
        if (!silent) showAlert({ severity: 'error', message: err.message });
      } finally {
        if (!silent) setVodsLoading(false);
      }
    },
    [vodUserLogin],
  );

  useEffect(() => {
    Promise.all([
      loadMe().catch(() => navigate('/', { replace: true })),
      loadSettings().catch((e) =>
        showAlert({ severity: 'error', message: e.message }),
      ),
      loadVideos().catch((e) =>
        showAlert({ severity: 'error', message: e.message }),
      ),
      loadPlaylist().catch(() => {}),
    ]).finally(() => setPageLoading(false));
  }, [loadMe, loadSettings, loadVideos, loadPlaylist, navigate]);

  useEffect(() => {
    if (libraryTab === 'vods' && user && vods.length === 0) loadVods();
  }, [libraryTab, user, vods.length, loadVods]);

  const loadClips = useCallback(
    async (after, silent = false) => {
      if (!silent) setClipsLoading(true);
      try {
        const data = await api.getClips(after, vodUserLogin ?? undefined, {
          sort: clipSortBy,
          creator: clipCreatorFilter,
          from: clipDateFrom,
          to: clipDateTo,
        });
        setClips((prev) => {
          if (!after) {
            if (silent && prev.length > 0) {
              const byId = new Map(data.data.map((c) => [c.id, c]));
              return prev.map((c) =>
                byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c,
              );
            }
            return data.data;
          }
          return [...prev, ...data.data];
        });
        if (!silent) setClipsPagination(data.pagination);
      } catch (err) {
        if (!silent) showAlert({ severity: 'error', message: err.message });
      } finally {
        if (!silent) setClipsLoading(false);
      }
    },
    [vodUserLogin, clipSortBy, clipCreatorFilter, clipDateFrom, clipDateTo],
  );

  useEffect(() => {
    if (libraryTab === 'clips' && user && clips.length === 0) loadClips();
  }, [libraryTab, user, clips.length, loadClips]);

  // A changed selection invalidates the loaded list; the effect above then reloads it.
  // The creator text is debounced to avoid a Twitch scan per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setClips([]);
      setClipsPagination(null);
    }, 400);
    return () => clearTimeout(id);
  }, [clipSortBy, clipCreatorFilter, clipDateFrom, clipDateTo]);

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
      if (user) loadClips(undefined, true).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [playlist, loadPlaylist, loadVods, loadClips, user]);

  if (pageLoading) return <PageLoading page="Player" />;
  if (!user) return null;

  async function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    try {
      await api.checkStorage(
        files.reduce((total, file) => total + file.size, 0),
      );
      // Open the upload dialog only when the selected files fit the limit.
      setUploadDialogFiles(files);
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function doUpload(files, metaList) {
    setUploadDialogFiles(null);
    setUploading(true);
    try {
      await api.checkStorage(
        files.reduce((total, file) => total + file.size, 0),
      );
      await api.uploadVideos(files, metaList);
      await Promise.all([loadVideos(), loadPlaylist()]);
      showAlert({
        severity: 'info',
        message: `${files.length} Datei(en) hochgeladen.`,
      });
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(name) {
    setDeleteConfirmation(name);
  }

  async function confirmDelete() {
    const name = deleteConfirmation;
    if (!name) return;
    setDeleteConfirmation(null);
    try {
      await api.deleteVideo(name);
      await Promise.all([loadVideos(), loadPlaylist()]);
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function handleImportVod(vod) {
    try {
      await api.importVod(vod.id, vod.title, {
        muted_segments: vod.muted_segments,
        created_at: vod.created_at,
      });
      await Promise.all([loadPlaylist(), loadVods()]);
      showAlert({
        severity: 'info',
        message: `Download von "${vod.title}" gestartet.`,
      });
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function handleImportClip(clip) {
    try {
      await api.importClip(clip.id, clip.title, {
        created_at: clip.created_at,
      });
      await Promise.all([loadPlaylist(), loadClips()]);
      showAlert({
        severity: 'info',
        message: `Download von "${clip.title}" gestartet.`,
      });
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function handleTogglePlaylistEntry(id, enabled) {
    try {
      await api.togglePlaylistEntry(id, enabled);
      await loadPlaylist();
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function handleAddToPlaylist(filename) {
    try {
      await api.addToPlaylist(filename);
      await loadPlaylist();
      showAlert({
        severity: 'info',
        message: 'Video zur Playlist hinzugefügt.',
      });
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function handleRemoveFromPlaylist(id) {
    try {
      await api.removeFromPlaylist(id);
      await loadPlaylist();
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
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
      showAlert({ severity: 'error', message: err.message });
    }
  }

  async function handleLogout() {
    await api.logout();
    navigate('/', { replace: true });
  }

  const readyPlaylist = playlist.filter(
    (e) => e.status === 'ready' && e.enabled && !e.needsCategory,
  );
  // Enabled playlist videos that are not in the streaming format: the next stream start
  // leaves them out.
  const formatProblems = videos
    .filter(
      (video) =>
        video.formatIssues?.length > 0 &&
        playlist.some(
          (e) => e.filename === video.name && e.status === 'ready' && e.enabled,
        ),
    )
    .map((video) => ({
      filename: video.name,
      title: video.transcript?.timestamps?.[0]?.title || video.name,
      problems: video.formatReport?.problems ?? [],
    }));

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
      {deleteConfirmation && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.75)',
            zIndex: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => setDeleteConfirmation(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-video-title"
            style={{
              background: 'var(--surface, #1a1a2e)',
              borderRadius: '8px',
              padding: '1.5rem',
              width: 'min(440px,92vw)',
              boxShadow: '0 8px 32px rgba(0,0,0,.6)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="delete-video-title" style={{ margin: '0 0 0.75rem' }}>
              Video löschen?
            </h3>
            <p
              style={{
                margin: '0 0 1rem',
                fontSize: '0.9rem',
                lineHeight: 1.5,
              }}
            >
              <strong>{deleteConfirmation}</strong> wird dauerhaft gelöscht und
              aus der Playlist entfernt. Diese Aktion kann nicht rückgängig
              gemacht werden.
            </p>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                justifyContent: 'flex-end',
                marginTop: '1.25rem',
              }}
            >
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDeleteConfirmation(null)}
              >
                Abbrechen
              </Button>
              <Button
                type="button"
                variant="ghost"
                danger
                onClick={confirmDelete}
              >
                Endgültig löschen
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConsoleHeader>
        <div>
          <Eyebrow>Erstelle deine 24/7 Twitch Playlist</Eyebrow>
          <h1>Twitch 24/7 Player</h1>
          {user.broadcasterLogin && (
            <Eyebrow
              as="a"
              href={`https://www.twitch.tv/${encodeURIComponent(user.broadcasterLogin)}`}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.45rem',
                margin: '0.4rem 0 0',
                textDecoration: 'none',
              }}
            >
              {user.broadcasterProfileImageUrl && (
                <img
                  src={user.broadcasterProfileImageUrl}
                  alt=""
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                />
              )}
              <strong>
                {user.broadcasterDisplayName || user.broadcasterLogin}
              </strong>
            </Eyebrow>
          )}
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
              <Button
                variant="ghost"
                onClick={handleLogout}
                style={{ fontSize: '0.8rem' }}
              >
                Logout
              </Button>
            </div>
          )}
          {PRIVILEGED_ROLES.includes(user.role) && (
            <Button
              as={Link}
              to="/settings"
              variant="ghost"
              style={{ fontSize: '0.8rem' }}
            >
              Einstellungen
            </Button>
          )}
        </div>
      </ConsoleHeader>
      <ConsoleGrid>
        <StreamHeroPanel
          settings={settings}
          setSettings={setSettings}
          readyPlaylist={readyPlaylist}
          formatProblems={formatProblems}
          userRole={user.role}
          playlistChangePending={playlistChangePending}
          onStreamStarted={handleStreamStarted}
        />

        <MediaLibraryPanel
          libraryTab={libraryTab}
          setLibraryTab={setLibraryTab}
          videos={videos}
          storage={storage}
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
          clips={clips}
          setClips={setClips}
          clipsLoading={clipsLoading}
          clipsPagination={clipsPagination}
          clipSortBy={clipSortBy}
          setClipSortBy={setClipSortBy}
          clipCreatorFilter={clipCreatorFilter}
          setClipCreatorFilter={setClipCreatorFilter}
          clipDateFrom={clipDateFrom}
          setClipDateFrom={setClipDateFrom}
          clipDateTo={clipDateTo}
          setClipDateTo={setClipDateTo}
          onImportClip={handleImportClip}
          onLoadMoreClips={loadClips}
        />
      </ConsoleGrid>

      {/* ── Active downloads ──────────────────────────────────────────────────── */}
      <DownloadsPanelFile
        onAborted={() =>
          Promise.all([
            loadPlaylist(),
            loadVideos(),
            loadVods(undefined, true),
            loadClips(undefined, true),
          ]).catch(() => {})
        }
      />

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
    </Console>
  );
}
