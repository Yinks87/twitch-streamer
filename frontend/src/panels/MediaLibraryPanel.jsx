import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import Thumbnail from '../components/Thumbnail';
import TimestampEditor from '../components/TimestampEditor';
import VideoTrimmer from '../components/VideoTrimmer';
import { api } from '../api';
import { useAlert } from '../context/AlertContext';
import {
  defaultTimestamp,
  normalizeTranscript,
  videoNeedsCategory,
} from '../utils/transcript';
import Button from '../components/Button';
import { Input, Select } from '../components/FormControls';
import ViewModeToggle, { useViewMode } from '../components/ViewModeToggle';
import {
  VideoGrid,
  VideoTile,
  TileMedia,
  TileBody,
  TileTitle,
  TileMeta,
  TileActions,
  VideoList,
  VideoListItem,
  VideoListName,
  VideoListSize,
  VideoListEmpty,
} from '../components/VideoList';
import {
  SOURCE_LABELS,
  StatusDot,
  VideoInfo,
  VideoInfoRow,
} from '../components/VideoInfo';

function formatVodDuration(dur) {
  // dur is like "1h2m3s" from Twitch API
  const h = dur.match(/(\d+)h/)?.[1] ?? '0';
  const m = dur.match(/(\d+)m/)?.[1] ?? '0';
  const s = dur.match(/(\d+)s/)?.[1] ?? '0';
  return `${h}h ${m}m ${s}s`;
}

// Clip duration comes back as a float in seconds (e.g. 12.9), unlike the VOD "1h2m3s" format.
function formatClipDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatStorage(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(2)} GB`;
}

function formatTranscriptTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

// ── Shared "whose channel" picker for the VOD and Clip tabs — both lists depend on
// the same vodUserLogin, so switching it resets whichever list(s) are currently loaded. ──
function RemoteSourceSelector({
  vodSource,
  setVodSource,
  vodUserLogin,
  setVodUserLogin,
  altUsernameInput,
  setAltUsernameInput,
  onSourceChange,
  ownHint,
  otherHint,
  promptHint,
}) {
  return (
    <>
      <SourceRow>
        <Select
          value={vodSource}
          onChange={(e) => {
            setVodSource(e.target.value);
            if (e.target.value === 'own') {
              setVodUserLogin(null);
              onSourceChange();
              api.saveSettings({ altStreamer: '' }).catch(() => {});
            }
          }}
        >
          <option value="other">Anderer Kanal</option>
          <option value="own">Eigener Kanal</option>
        </Select>

        {vodSource === 'other' && (
          <AltUserForm
            onSubmit={(e) => {
              e.preventDefault();
              const name = altUsernameInput.trim();
              if (!name) return;
              setVodUserLogin(name);
              onSourceChange();
              api.saveSettings({ altStreamer: name }).catch(() => {});
            }}
          >
            <Input
              type="text"
              placeholder="Twitch-Benutzername"
              value={altUsernameInput}
              onChange={(e) => setAltUsernameInput(e.target.value)}
              style={{ minWidth: '160px' }}
            />
            <Button variant="primary" type="submit">
              Laden
            </Button>
          </AltUserForm>
        )}
      </SourceRow>
      <Hint>
        {vodSource === 'own' ? ownHint : vodUserLogin ? otherHint : promptHint}
      </Hint>
    </>
  );
}

// ── Shared import button: ready / downloading / error / not-yet-imported states —
// used by both the VOD and Clip rows. ───────────────────────────────────────────
function ImportStatusButton({ status, onImport }) {
  const [pending, setPending] = useState(false);

  // Disabled until the import request (and subsequent status refresh) completes.
  async function handleClick() {
    if (pending) return;
    setPending(true);
    try {
      await onImport();
    } finally {
      setPending(false);
    }
  }

  if (status === 'ready') {
    return (
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
          fontSize: '0.875rem',
          color: 'var(--color-success, #4caf50)',
        }}
      >
        <span className="material-symbols-outlined small">download_done</span>{' '}
        Importiert
      </span>
    );
  }
  if (status === 'downloading') {
    return (
      <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>⏳ Wird geladen…</span>
    );
  }
  if (status === 'error') {
    return (
      <Button
        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
        variant="ghost"
        danger
        disabled={pending}
        onClick={handleClick}
      >
        <span className="material-symbols-outlined small">
          file_download_off
        </span>{' '}
        Wiederholen
      </Button>
    );
  }
  return (
    <Button
      style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
      variant="ghost"
      disabled={pending}
      onClick={handleClick}
    >
      <span className="material-symbols-outlined small">download</span>{' '}
      {pending ? 'Startet…' : 'Importieren'}
    </Button>
  );
}

function ImportFilterSelect({ value, onChange }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="all">Status: Alle</option>
      <option value="imported">Status: Importiert</option>
      <option value="not_imported">Status: Nicht importiert</option>
    </Select>
  );
}

function TrimProgressStatus({ trimProgress }) {
  const percent =
    typeof trimProgress.progress === 'number'
      ? Math.max(0, Math.min(100, trimProgress.progress))
      : null;

  return (
    <TrimStatus role="status">
      <TrimStatusText>
        <span>
          {trimProgress.queued ? 'Schnitt wartet' : 'Wird geschnitten'}
        </span>
        <span>{percent != null ? `${percent.toFixed(1)}%` : 'Wartet…'}</span>
      </TrimStatusText>
      <TrimProgressTrack
        aria-label={
          percent != null
            ? `Schnittfortschritt: ${percent.toFixed(1)}%`
            : 'Schnitt wartet auf den Start'
        }
      >
        <TrimProgressFill $percent={percent} />
      </TrimProgressTrack>
    </TrimStatus>
  );
}

// -- One remote VOD/clip: list row or tile ------------------------------------
function RemoteItem({ grid, thumbUrl, title, meta, status, onImport }) {
  const hideOnError = (e) => (e.currentTarget.style.display = 'none');

  if (grid) {
    return (
      <VideoTile>
        <TileMedia>
          {thumbUrl && (
            <img
              src={thumbUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={hideOnError}
            />
          )}
        </TileMedia>
        <TileBody>
          <TileTitle title={title}>{title}</TileTitle>
          <TileMeta>{meta}</TileMeta>
          <TileActions>
            <ImportStatusButton status={status} onImport={onImport} />
          </TileActions>
        </TileBody>
      </VideoTile>
    );
  }

  return (
    <VodRow>
      {thumbUrl && (
        <img
          src={thumbUrl}
          alt=""
          style={{
            width: '80px',
            height: '45px',
            objectFit: 'cover',
            borderRadius: '4px',
            flexShrink: 0,
          }}
          onError={hideOnError}
        />
      )}
      <VideoListName style={{ flex: '1 1 60%' }} title={title}>
        {title}
      </VideoListName>
      <VideoListSize
        style={{ fontSize: '0.75rem', opacity: 0.65, flex: '1 1 100%' }}
      >
        {meta}
      </VideoListSize>
      <ImportStatusButton status={status} onImport={onImport} />
    </VodRow>
  );
}

// "?" button with the transcript details card. The card is rendered in a portal with
// fixed positioning so the scrollable tile list cannot clip it.
function TranscriptInfo({ floating, children }) {
  const infoId = useId();
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const cardRef = useRef(null);
  const open = pos !== null;

  const show = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 32);
    const left = Math.min(
      Math.max(16, rect.right - width),
      window.innerWidth - width - 16,
    );
    const maxHeight = Math.max(
      160,
      Math.min(360, window.innerHeight - rect.bottom - 16),
    );
    setPos({ top: rect.bottom, left, width, maxHeight });
  }, []);
  const hide = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!open) return undefined;
    const onScroll = (event) => {
      if (!cardRef.current?.contains(event.target)) hide();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  return (
    <TranscriptInfoControl
      $floating={floating}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          !event.currentTarget.contains(next) &&
          !cardRef.current?.contains(next)
        ) {
          hide();
        }
      }}
    >
      <TranscriptInfoButton
        ref={buttonRef}
        type="button"
        aria-label="Transkriptinformationen anzeigen"
        aria-expanded={open}
        aria-controls={`transcript-info-${infoId}`}
        onClick={() => (open ? hide() : show())}
      >
        ?
      </TranscriptInfoButton>
      {open &&
        createPortal(
          <TranscriptInfoCard
            ref={cardRef}
            id={`transcript-info-${infoId}`}
            role="region"
            aria-label="Transkriptinformationen"
            style={pos}
          >
            {children}
          </TranscriptInfoCard>,
          document.body,
        )}
    </TranscriptInfoControl>
  );
}

// ── One uploaded video: collapsed row / expanded transcript editor ───────────
function MediaLibraryItem({
  grid,
  video,
  playlistEntry,
  onRefresh,
  onDelete,
  onAddToPlaylist,
  trimProgress,
  onTrimProgress,
}) {
  const { showAlert } = useAlert();
  const storageKey = `twitch-streamer.mediathek.${video.name}`;
  const [expanded, setExpanded] = useState(
    () => window.localStorage.getItem(storageKey) === 'expanded',
  );
  const [timestamps, setTimestamps] = useState(
    () => normalizeTranscript(video.transcript || {}).timestamps,
  );
  const [saving, setSaving] = useState(false);
  const initialTimestamps = normalizeTranscript(
    video.transcript || {},
  ).timestamps;
  const isDirty =
    JSON.stringify(timestamps) !== JSON.stringify(initialTimestamps);
  const videoRef = useRef(null);
  const [videoDuration, setVideoDuration] = useState(null);
  // Bumped after a trim so the preview re-fetches the replaced file instead of
  // reusing the browser's cached bytes for the same (unchanged) filename/URL.
  const [reloadToken, setReloadToken] = useState(0);
  const previewSrc = `/api/v1/videos/${encodeURIComponent(video.name)}/stream${
    reloadToken ? `?t=${reloadToken}` : ''
  }`;
  const transcriptSignature = JSON.stringify(video.transcript || {});
  const needsCategory = videoNeedsCategory(video.transcript);
  const isActive = Boolean(
    playlistEntry?.enabled && !playlistEntry?.needsCategory,
  );

  async function handleTrim(segments) {
    // Stop any in-flight preview requests first — Windows can otherwise lock the
    // file while the backend tries to replace it with the trimmed result.
    videoRef.current?.pause();
    videoRef.current?.removeAttribute('src');
    videoRef.current?.load();
    const result = await api.trimVideo(video.name, segments);
    handleTrimFinished();
    return result;
  }

  async function handleTrimFinished() {
    // Forces the <video> below to reload the (same-named) file from scratch.
    setReloadToken(Date.now());
    await onRefresh?.();
  }

  useEffect(() => {
    if (reloadToken) videoRef.current?.load();
  }, [reloadToken]);

  useEffect(() => {
    window.localStorage.setItem(
      storageKey,
      expanded ? 'expanded' : 'collapsed',
    );
  }, [expanded, storageKey]);

  useEffect(() => {
    setTimestamps(normalizeTranscript(video.transcript || {}).timestamps);
  }, [transcriptSignature]);

  const trimIsRunning = Boolean(trimProgress);
  useEffect(() => {
    if (!trimIsRunning || expanded) return undefined;
    let cancelled = false;

    async function pollTrimProgress() {
      try {
        const data = await api.getTrimProgress(video.name);
        if (cancelled) return;
        const running =
          typeof data.progress === 'number' || Boolean(data.queued);
        onTrimProgress(
          video.name,
          running
            ? {
                progress:
                  typeof data.progress === 'number' ? data.progress : null,
                queued: Boolean(data.queued),
              }
            : null,
        );
      } catch {
        // Keep the last known tile status during transient polling errors.
      }
    }

    pollTrimProgress();
    const intervalId = setInterval(pollTrimProgress, 1000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [expanded, onTrimProgress, trimIsRunning, video.name]);

  async function saveTranscript() {
    setSaving(true);
    try {
      await api.updateTranscript(video.name, {
        timestamps: timestamps.length ? timestamps : [defaultTimestamp()],
      });
      await onRefresh?.();
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    } finally {
      setSaving(false);
    }
  }

  const tile = grid && !expanded;
  const displayTitle = video.transcript?.timestamps?.[0]?.title || video.name;
  const transcriptTimestamps = Array.isArray(video.transcript?.timestamps)
    ? video.transcript.timestamps
    : [];
  const mutedSegments = Array.isArray(video.transcript?.mutedSegments)
    ? video.transcript.mutedSegments
    : [];
  const thumbSrc = `/api/v1/thumbnails/${encodeURIComponent(video.name)}${
    reloadToken ? `?t=${reloadToken}` : ''
  }`;
  const handleTrimProgress = (progress) => onTrimProgress(video.name, progress);
  const statusDot = (
    <StatusDot
      $active={isActive}
      aria-label={
        isActive
          ? 'Aktiv und in der Playlist'
          : 'Nicht aktiv oder nicht in der Playlist'
      }
      title={
        isActive
          ? 'Aktiv und in der Playlist'
          : playlistEntry
            ? 'In der Playlist, aber deaktiviert'
            : 'Nicht in der Playlist'
      }
    />
  );

  const transcriptInfoContent = (
    <>
      {transcriptTimestamps.length === 0 && mutedSegments.length === 0 ? (
        <TranscriptInfoEmpty>
          Keine Transkriptinformationen vorhanden.
        </TranscriptInfoEmpty>
      ) : (
        <>
          {transcriptTimestamps.length > 0 && (
            <TranscriptInfoSection>
              <TranscriptInfoHeading>Zeitstempel</TranscriptInfoHeading>
              {transcriptTimestamps.map((timestamp, index) => (
                <TranscriptInfoEntry
                  key={`${timestamp.time || 'time'}-${index}`}
                >
                  <TranscriptInfoTime>
                    {timestamp.time || '00:00:00'}
                  </TranscriptInfoTime>
                  <div>
                    <TranscriptInfoValue>
                      Titel: {timestamp.title || 'Kein Titel'}
                    </TranscriptInfoValue>
                    <TranscriptInfoValue>
                      Kategorie: {timestamp.category || 'Nicht gesetzt'}
                    </TranscriptInfoValue>
                    {timestamp.category_id != null && (
                      <TranscriptInfoDetail>
                        Twitch-Kategorie-ID: {timestamp.category_id}
                      </TranscriptInfoDetail>
                    )}
                  </div>
                </TranscriptInfoEntry>
              ))}
            </TranscriptInfoSection>
          )}
          {mutedSegments.length > 0 && (
            <TranscriptInfoSection>
              <TranscriptInfoHeading>
                Stummgeschaltete Bereiche
              </TranscriptInfoHeading>
              {mutedSegments.map((segment, index) => (
                <TranscriptInfoEntry
                  key={`${segment.offset}-${segment.duration}-${index}`}
                >
                  <TranscriptInfoValue>
                    {formatTranscriptTime(segment.offset)} –{' '}
                    {formatTranscriptTime(
                      Number(segment.offset) + Number(segment.duration),
                    )}
                  </TranscriptInfoValue>
                  <TranscriptInfoDetail>
                    Dauer: {formatTranscriptTime(segment.duration)}
                  </TranscriptInfoDetail>
                </TranscriptInfoEntry>
              ))}
            </TranscriptInfoSection>
          )}
        </>
      )}
    </>
  );

  const addedAt = playlistEntry?.created_at ?? video.uploadedAt;
  const transferredAt =
    video.source === 'upload' ? null : playlistEntry?.twitch_created_at;
  const transcriptInfo = !expanded && (
    <TranscriptInfo floating={!tile}>{transcriptInfoContent}</TranscriptInfo>
  );

  return (
    <ItemRow $tile={tile} $grid={grid} $wide={grid && expanded}>
      {!tile && transcriptInfo}
      <ItemHeader
        type="button"
        $tile={tile}
        title={tile ? displayTitle : undefined}
        aria-label={tile ? displayTitle : undefined}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {tile ? (
          <>
            <TileMedia>
              <Thumbnail src={thumbSrc} alt="" fluid />
            </TileMedia>
            {(trimProgress || needsCategory) && (
              <TileBody>
                {trimProgress && (
                  <TrimProgressStatus trimProgress={trimProgress} />
                )}
                {needsCategory && <Warning>Transkript unvollständig</Warning>}
              </TileBody>
            )}
          </>
        ) : (
          <>
            {statusDot}
            <Thumbnail src={thumbSrc} alt="" />
            <VideoListName style={{ minWidth: 0 }}>
              {displayTitle}
            </VideoListName>
            {trimProgress && <TrimProgressStatus trimProgress={trimProgress} />}
            {needsCategory && <Warning>Transkript unvollständig</Warning>}

            <ToggleIcon aria-hidden="true">
              <span
                style={{
                  transition: 'transform 0.1s ease-in-out',
                  transform: expanded ? 'rotate(90deg)' : 'rotate(270deg)',
                }}
                className="material-symbols-outlined small"
              >
                arrow_forward_ios
              </span>
            </ToggleIcon>
          </>
        )}
      </ItemHeader>

      {tile && (
        <VideoInfoRow>
          <VideoInfo
            active={isActive}
            source={video.source}
            duration={video.duration}
            addedAt={addedAt}
            transferredAt={transferredAt}
          />
          {transcriptInfo}
        </VideoInfoRow>
      )}

      {expanded && (
        <ItemBody>
          <ItemMeta>
            <span style={{ fontSize: '0.75rem', opacity: 0.65 }}>
              {SOURCE_LABELS[video.source] || 'Upload'} ·{' '}
              {new Date(video.uploadedAt).toLocaleString('de-DE')} ·{' '}
              {playlistEntry
                ? isActive
                  ? 'Aktiv in der Playlist'
                  : 'In der Playlist deaktiviert'
                : 'Nicht in der Playlist'}
            </span>
          </ItemMeta>
          <Preview
            ref={videoRef}
            src={previewSrc}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => {
              e.currentTarget.volume = 0.2;
              setVideoDuration(e.currentTarget.duration);
            }}
          />
          <VideoTrimmer
            duration={videoDuration}
            mutedSegments={video.transcript?.mutedSegments || []}
            onTrim={handleTrim}
            onTrimFinished={handleTrimFinished}
            onProgress={handleTrimProgress}
            videoName={video.name}
          />
          <TimestampEditor
            timestamps={timestamps}
            onChange={setTimestamps}
            storageKeyPrefix={`mediathek.${video.name}`}
            getCurrentTime={() => videoRef.current?.currentTime}
          />
          <ItemActions>
            {!playlistEntry && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onAddToPlaylist(video.name)}
              >
                Zur Playlist hinzufügen
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              danger
              onClick={() => onDelete(video.name)}
            >
              <span className="material-symbols-outlined small">delete</span>
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={saveTranscript}
              disabled={saving || !isDirty}
            >
              <span className="material-symbols-outlined small">save</span>
            </Button>
          </ItemActions>
        </ItemBody>
      )}
    </ItemRow>
  );
}

export default function MediaLibraryPanel({
  libraryTab,
  setLibraryTab,
  videos,
  storage,
  uploading,
  dragOver,
  setDragOver,
  fileInputRef,
  handleFiles,
  playlist,
  onRefresh,
  onDelete,
  onAddToPlaylist,
  user,
  vodSource,
  setVodSource,
  vodUserLogin,
  setVodUserLogin,
  vods,
  setVods,
  vodsLoading,
  vodsPagination,
  setVodsPagination,
  altUsernameInput,
  setAltUsernameInput,
  onImportVod,
  onLoadMoreVods,
  onImportClip,
  clips,
  setClips,
  clipsLoading,
  clipsPagination,
  clipSortBy,
  setClipSortBy,
  clipCreatorFilter,
  setClipCreatorFilter,
  clipDateFrom,
  setClipDateFrom,
  clipDateTo,
  setClipDateTo,
  onLoadMoreClips,
}) {
  // Both the VOD and Clip tab browse the same channel, so switching it must reset both.
  function resetRemoteLists() {
    setVods([]);
    setVodsPagination(null);
    setClips([]);
  }

  const [viewMode, setViewMode] = useViewMode('library');
  const grid = viewMode === 'grid';
  const [trimProgressByVideo, setTrimProgressByVideo] = useState({});

  const updateTrimProgress = useCallback((name, progress) => {
    setTrimProgressByVideo((current) => {
      if (!progress) {
        if (!(name in current)) return current;
        const next = { ...current };
        delete next[name];
        return next;
      }
      const previous = current[name];
      if (
        previous?.progress === progress.progress &&
        previous?.queued === progress.queued
      )
        return current;
      return { ...current, [name]: progress };
    });
  }, []);

  const [videoSort, setVideoSort] = useState('desc'); // 'desc' | 'asc'
  const [videoTypeFilter, setVideoTypeFilter] = useState('all'); // 'all' | 'upload' | 'vod' | 'clip'
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [importFilter, setImportFilter] = useState('all'); // 'all' | 'imported' | 'not_imported'

  const matchesImportFilter = (item) =>
    importFilter === 'all' ||
    (importFilter === 'imported'
      ? item.importStatus === 'ready'
      : item.importStatus !== 'ready');

  const [videoStatusFilter, setVideoStatusFilter] = useState('all'); // 'all' | 'active' | 'inactive' | 'incomplete'
  const searchTerm = transcriptSearch.trim().toLocaleLowerCase('de-DE');

  const matchesVideoStatus = (video) => {
    if (videoStatusFilter === 'all') return true;
    const entry = playlist.find((e) => e.filename === video.name);
    const active = Boolean(entry?.enabled && !entry?.needsCategory);
    if (videoStatusFilter === 'active') return active;
    if (videoStatusFilter === 'inactive') return !active;
    return videoNeedsCategory(video.transcript);
  };

  const matchesTranscriptSearch = (video) => {
    if (!searchTerm) return true;

    const transcript = video.transcript || {};
    const timestamps = Array.isArray(transcript.timestamps)
      ? transcript.timestamps
      : [];
    const searchableText = [
      transcript.title,
      transcript.category,
      ...timestamps.flatMap((timestamp) => [
        timestamp?.title,
        timestamp?.category,
      ]),
    ]
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLocaleLowerCase('de-DE');

    return searchableText.includes(searchTerm);
  };

  const visibleVideos = videos
    .filter(
      (video) => videoTypeFilter === 'all' || video.source === videoTypeFilter,
    )
    .filter(matchesVideoStatus)
    .filter(matchesTranscriptSearch)
    .slice()
    .sort((a, b) => {
      const diff = new Date(a.uploadedAt) - new Date(b.uploadedAt);
      return videoSort === 'asc' ? diff : -diff;
    });

  const visibleVods = vods.filter(matchesImportFilter);

  // Sorting, creator and date selection are applied by the backend against Twitch.
  const visibleClips = clips.filter(matchesImportFilter);

  return (
    <CollapsiblePanel storageKey="library" title="Medienbibliothek">
      <Tabs>
        <Button
          variant={libraryTab === 'videos' ? 'primary' : 'ghost'}
          onClick={() => setLibraryTab('videos')}
        >
          Alle Videos ({videos.length})
        </Button>
        <Button
          variant={libraryTab === 'uploads' ? 'primary' : 'ghost'}
          onClick={() => setLibraryTab('uploads')}
        >
          Upload
        </Button>
        <Button
          variant={libraryTab === 'vods' ? 'primary' : 'ghost'}
          onClick={() => setLibraryTab('vods')}
        >
          VODs
        </Button>
        <Button
          variant={libraryTab === 'clips' ? 'primary' : 'ghost'}
          onClick={() => setLibraryTab('clips')}
        >
          Clips
        </Button>
      </Tabs>

      <StorageSummary
        $ratio={
          storage?.limitBytes
            ? (storage.usedBytes / storage.limitBytes) * 100
            : null
        }
      >
        Aktueller Speicherbedarf: {formatStorage(storage?.usedBytes)}
      </StorageSummary>

      {libraryTab === 'uploads' && (
        <>
          <Hint>
            Videos hochladen, um sie anschließend in der Mediathek zu verwalten.
          </Hint>
          <Dropzone
            $active={dragOver}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              multiple
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
            <p>
              {uploading ? 'Lade hoch…' : 'Videos hierher ziehen oder klicken'}
            </p>
          </Dropzone>
        </>
      )}

      {libraryTab === 'videos' && (
        <>
          <Hint>Filtern und sortieren</Hint>
          <SourceRow>
            <Input
              type="search"
              aria-label="Transkripte nach Titel oder Kategorie durchsuchen"
              placeholder="Titel oder Kategorie suchen…"
              value={transcriptSearch}
              onChange={(e) => setTranscriptSearch(e.target.value)}
              style={{ flex: '1 1 220px', minWidth: '180px' }}
            />
            <Select
              value={videoTypeFilter}
              onChange={(e) => setVideoTypeFilter(e.target.value)}
            >
              <option value="all">Typ: Alle</option>
              <option value="upload">Uploads</option>
              <option value="vod">VODs</option>
              <option value="clip">Clips</option>
            </Select>
            <Select
              value={videoStatusFilter}
              onChange={(e) => setVideoStatusFilter(e.target.value)}
            >
              <option value="all">Status: Alle</option>
              <option value="active">Aktiviert</option>
              <option value="inactive">Deaktiviert</option>
              <option value="incomplete">Transkript unvollständig</option>
            </Select>
            <Select
              value={videoSort}
              onChange={(e) => setVideoSort(e.target.value)}
            >
              <option value="desc">Datum: Neueste zuerst</option>
              <option value="asc">Datum: Älteste zuerst</option>
            </Select>
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          </SourceRow>
          <ItemList $grid={grid}>
            {visibleVideos.length === 0 && (
              <VideoListEmpty style={{ gridColumn: '1 / -1' }}>
                {videos.length === 0
                  ? 'Noch keine Videos in der Mediathek vorhanden.'
                  : searchTerm
                    ? 'Keine Videos für diese Suche und Filter.'
                    : 'Keine Videos für diesen Filter.'}
              </VideoListEmpty>
            )}
            {visibleVideos.map((video) => (
              <MediaLibraryItem
                key={video.name}
                grid={grid}
                video={video}
                playlistEntry={playlist.find(
                  (entry) => entry.filename === video.name,
                )}
                onRefresh={onRefresh}
                onDelete={onDelete}
                onAddToPlaylist={onAddToPlaylist}
                trimProgress={trimProgressByVideo[video.name]}
                onTrimProgress={updateTrimProgress}
              />
            ))}
          </ItemList>
        </>
      )}

      {libraryTab === 'vods' && user && (
        <>
          <RemoteSourceSelector
            vodSource={vodSource}
            setVodSource={setVodSource}
            vodUserLogin={vodUserLogin}
            setVodUserLogin={setVodUserLogin}
            altUsernameInput={altUsernameInput}
            setAltUsernameInput={setAltUsernameInput}
            onSourceChange={resetRemoteLists}
            ownHint={
              <>
                Deine Twitch-Aufzeichnungen. "Importieren" lädt sie per yt-dlp
                herunter.
              </>
            }
            otherHint={
              <>
                VODs von {vodUserLogin} "Importieren" - lädt sie per yt-dlp
                herunter.
              </>
            }
            promptHint={<>Benutzernamen eingeben und "Laden" klicken.</>}
          />

          <SourceRow>
            <ImportFilterSelect
              value={importFilter}
              onChange={setImportFilter}
            />
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          </SourceRow>

          {vodSource === 'other' && !vodUserLogin ? null : vodsLoading &&
            vods.length === 0 ? (
            <p style={{ opacity: 0.6 }}>Lade VODs…</p>
          ) : visibleVods.length === 0 ? (
            <p style={{ opacity: 0.6 }}>Keine Aufzeichnungen gefunden.</p>
          ) : (
            <ItemsContainer $grid={grid}>
              {visibleVods.map((vod) => (
                <RemoteItem
                  key={vod.id}
                  grid={grid}
                  thumbUrl={vod.thumbnail_url
                    ?.replace(/%?\{width\}/g, '320')
                    ?.replace(/%?\{height\}/g, '180')}
                  title={vod.title}
                  meta={`${formatVodDuration(vod.duration)} · ${new Date(
                    vod.created_at,
                  ).toLocaleDateString()}`}
                  status={vod.importStatus}
                  onImport={() => onImportVod(vod)}
                />
              ))}
            </ItemsContainer>
          )}
          {vodsPagination?.cursor && (
            <Button
              variant="ghost"
              onClick={() => onLoadMoreVods(vodsPagination.cursor)}
              disabled={vodsLoading}
              style={{ marginTop: '0.5rem' }}
            >
              {vodsLoading ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <span className="material-symbols-outlined small">
                    hourglass_check
                  </span>{' '}
                  Lädt…
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <span className="material-symbols-outlined small">
                    sync_arrow_down
                  </span>{' '}
                  Mehr laden
                </div>
              )}
            </Button>
          )}
        </>
      )}

      {libraryTab === 'clips' && user && (
        <>
          <RemoteSourceSelector
            vodSource={vodSource}
            setVodSource={setVodSource}
            vodUserLogin={vodUserLogin}
            setVodUserLogin={setVodUserLogin}
            altUsernameInput={altUsernameInput}
            setAltUsernameInput={setAltUsernameInput}
            onSourceChange={resetRemoteLists}
            ownHint={
              <>
                Deine Twitch-Clips "Importieren"; lädt sie per yt-dlp herunter.
              </>
            }
            otherHint={
              <>
                Clips von {vodUserLogin} "Importieren" lädt sie per yt-dlp
                herunter.
              </>
            }
            promptHint={<>Benutzernamen eingeben und "Laden" klicken.</>}
          />

          <SourceRow>
            <Select
              value={clipSortBy}
              onChange={(e) => setClipSortBy(e.target.value)}
            >
              <option value="date">Sortierung: Datum (neueste zuerst)</option>
              <option value="views">Sortierung: Aufrufe (meiste zuerst)</option>
            </Select>
            <ImportFilterSelect
              value={importFilter}
              onChange={setImportFilter}
            />
            <Input
              type="text"
              placeholder="Nach Clip-Ersteller filtern…"
              value={clipCreatorFilter}
              onChange={(e) => setClipCreatorFilter(e.target.value)}
              style={{ minWidth: '180px' }}
            />
            <Input
              type="date"
              title="Von"
              value={clipDateFrom}
              max={clipDateTo || undefined}
              onChange={(e) => setClipDateFrom(e.target.value)}
            />
            <Input
              type="date"
              title="Bis"
              value={clipDateTo}
              min={clipDateFrom || undefined}
              onChange={(e) => setClipDateTo(e.target.value)}
            />
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          </SourceRow>

          {vodSource === 'other' && !vodUserLogin ? null : clipsLoading &&
            clips.length === 0 ? (
            <p style={{ opacity: 0.6 }}>Lade Clips…</p>
          ) : visibleClips.length === 0 ? (
            <p style={{ opacity: 0.6 }}>Keine Clips gefunden.</p>
          ) : (
            <ItemsContainer $grid={grid}>
              {visibleClips.map((clip) => (
                <RemoteItem
                  key={clip.id}
                  grid={grid}
                  thumbUrl={clip.thumbnail_url}
                  title={clip.title}
                  meta={`${clip.creator_name} · ${formatClipDuration(
                    clip.duration,
                  )} · ${clip.view_count?.toLocaleString(
                    'de-DE',
                  )} Aufrufe · ${new Date(
                    clip.created_at,
                  ).toLocaleDateString()}`}
                  status={clip.importStatus}
                  onImport={() => onImportClip(clip)}
                />
              ))}
            </ItemsContainer>
          )}
          {clipsPagination?.cursor && (
            <Button
              variant="ghost"
              onClick={() => onLoadMoreClips(clipsPagination.cursor)}
              disabled={clipsLoading}
              style={{ marginTop: '0.5rem' }}
            >
              {clipsLoading ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <span className="material-symbols-outlined small">
                    hourglass_check
                  </span>{' '}
                  Lädt…
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                  }}
                >
                  <span className="material-symbols-outlined small">
                    sync_arrow_down
                  </span>{' '}
                  Mehr laden
                </div>
              )}
            </Button>
          )}
        </>
      )}
    </CollapsiblePanel>
  );
}

const Tabs = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
`;

const StorageSummary = styled.div`
  margin: 0.75rem 0 1rem;
  font-size: 0.8rem;
  color: ${({ $ratio }) =>
    $ratio == null
      ? 'var(--text-dim)'
      : $ratio > 100
        ? 'var(--color-danger, #e5484d)'
        : $ratio >= 80
          ? 'var(--color-warning, #e0a326)'
          : 'var(--color-success, #4caf50)'};
`;

const Hint = styled.p`
  margin: 0 0 16px;
  color: var(--text-dim);
  font-size: 0.85rem;
`;

const Dropzone = styled.div`
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 26px 16px;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.88rem;
  cursor: pointer;
  margin-bottom: 16px;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;

  ${({ $active }) =>
    $active &&
    `
    border-color: var(--signal);
    color: var(--text);
  `}
`;

const SourceRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
`;

const AltUserForm = styled.form`
  display: flex;
  gap: 0.4rem;
`;

const VodRow = styled(VideoListItem)`
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: flex-start;
`;

const ItemList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;

  ${({ $grid }) =>
    $grid &&
    `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 12px;
  `}
`;

// VOD/clip results: scrollable list or tile grid.
function ItemsContainer({ $grid, children }) {
  return $grid ? (
    <VideoGrid $maxHeight="560px">{children}</VideoGrid>
  ) : (
    <VideoList>{children}</VideoList>
  );
}

const ItemRow = styled(VideoListItem)`
  display: block;
  padding: 0;
  position: relative;
  /* Expanded rows must not clip the category autocomplete dropdown. */
  overflow: visible;

  ${({ $grid }) =>
    $grid &&
    `
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-raised);
    &:last-child {
      border-bottom: 1px solid var(--border);
    }
  `}
  /* Clip the thumbnail to the rounded tile corners. */
  ${({ $tile }) => $tile && 'overflow: hidden;'}
  ${({ $wide }) => $wide && 'grid-column: 1 / -1;'}
`;

const TranscriptInfoControl = styled.div`
  flex-shrink: 0;
  ${({ $floating }) =>
    $floating &&
    `
    position: absolute;
    z-index: 5;
    top: 50%;
    right: 38px;
    transform: translateY(-50%);
  `}
`;

const TranscriptInfoButton = styled.button`
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 50%;
  background: rgba(21, 23, 27, 0.85);
  color: var(--text);
  font: 600 0.85rem var(--font-display);
  cursor: help;

  &:hover,
  &:focus-visible {
    border-color: var(--signal);
    color: var(--signal);
    outline: none;
  }
`;

const TranscriptInfoCard = styled.div`
  position: fixed;
  z-index: 1000;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  color: var(--text);
  cursor: default;
`;

const TranscriptInfoSection = styled.section`
  & + & {
    margin-top: 0.75rem;
    padding-top: 0.65rem;
    border-top: 1px solid var(--border);
  }
`;

const TranscriptInfoHeading = styled.h3`
  margin-bottom: 0.45rem;
  color: var(--text-dim);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
`;

const TranscriptInfoEntry = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0.35rem 0;
  font-size: 0.75rem;
  overflow-wrap: anywhere;

  & + & {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
`;

const TranscriptInfoTime = styled.span`
  color: var(--signal);
  font-family: var(--font-mono);
  white-space: nowrap;
`;

const TranscriptInfoValue = styled.div`
  color: var(--text);
`;

const TranscriptInfoDetail = styled.div`
  margin-top: 0.15rem;
  color: var(--text-dim);
  font-size: 0.7rem;
`;

const TranscriptInfoEmpty = styled.p`
  color: var(--text-dim);
  font-size: 0.78rem;
`;

const ItemHeader = styled.button`
  display: flex;
  align-items: center;
  gap: 0.65rem;
  width: 100%;
  padding: 0.65rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;

  ${({ $tile }) =>
    $tile &&
    `
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    padding: 0;
  `}
`;

const ToggleIcon = styled.span`
  margin-left: auto;
  color: var(--text-dim, #8d9198);
  font-family: monospace;
  font-size: 1.2rem;
  line-height: 1;
  flex-shrink: 0;
`;

const ItemBody = styled.div`
  padding: 0 0.65rem 0.75rem;
`;

const Preview = styled.video`
  display: block;
  width: 100%;
  max-height: 320px;
  border-radius: 6px;
  background: #000;
  margin-bottom: 0.65rem;
`;

const ItemMeta = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
`;

const Warning = styled.span`
  font-size: 0.75rem;
  color: var(--color-warning, #e0a326);
`;

const TrimStatus = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 100px;
  color: var(--text);
  font-size: 0.72rem;
`;

const TrimStatusText = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 8px;
`;

const TrimProgressTrack = styled.div`
  height: 5px;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.15);
`;

const TrimProgressFill = styled.div`
  width: ${({ $percent }) => `${$percent ?? 0}%`};
  height: 100%;
  background: var(--signal, #9147ff);
  transition: width 0.4s ease;
`;

const ItemActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
`;
