import { useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';
import CollapsiblePanel from '../components/CollapsiblePanel';
import Thumbnail from '../components/Thumbnail';
import TimestampEditor from '../components/TimestampEditor';
import { api } from '../api';
import {
  defaultTimestamp,
  normalizeTranscript,
  videoNeedsCategory,
} from '../utils/transcript';
import Button from '../components/Button';
import { Input, Select } from '../components/FormControls';
import {
  VideoList,
  VideoListItem,
  VideoListName,
  VideoListSize,
  VideoListEmpty,
} from '../components/VideoList';

function formatVodDuration(dur) {
  // dur is like "1h2m3s" from Twitch API
  const h = dur.match(/(\d+)h/)?.[1] ?? '0';
  const m = dur.match(/(\d+)m/)?.[1] ?? '0';
  const s = dur.match(/(\d+)s/)?.[1] ?? '0';
  return `${h}h ${m}m ${s}s`;
}

// ── One uploaded video: collapsed row / expanded transcript editor ───────────
function MediaLibraryItem({
  video,
  playlistEntry,
  onRefresh,
  onDelete,
  onAddToPlaylist,
}) {
  const storageKey = `twitch-streamer.mediathek.${video.name}`;
  const [expanded, setExpanded] = useState(
    () => window.localStorage.getItem(storageKey) === 'expanded',
  );
  const [timestamps, setTimestamps] = useState(
    () => normalizeTranscript(video.transcript || {}).timestamps,
  );
  const [saving, setSaving] = useState(false);
  const videoRef = useRef(null);
  const transcriptSignature = JSON.stringify(video.transcript || {});
  const needsCategory = videoNeedsCategory(video.transcript);
  const isActive = Boolean(
    playlistEntry?.enabled && !playlistEntry?.needsCategory,
  );

  useEffect(() => {
    window.localStorage.setItem(
      storageKey,
      expanded ? 'expanded' : 'collapsed',
    );
  }, [expanded, storageKey]);

  useEffect(() => {
    setTimestamps(normalizeTranscript(video.transcript || {}).timestamps);
  }, [transcriptSignature]);

  async function saveTranscript() {
    setSaving(true);
    try {
      await api.updateTranscript(video.name, {
        timestamps: timestamps.length ? timestamps : [defaultTimestamp()],
      });
      await onRefresh?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ItemRow>
      <ItemHeader
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
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
        <Thumbnail
          src={`/api/v1/thumbnails/${encodeURIComponent(video.name)}`}
          alt=""
        />
        <VideoListName style={{ minWidth: 0 }}>
          {video.transcript?.timestamps?.[0]?.title || video.name}
        </VideoListName>
        <ToggleIcon aria-hidden="true">{expanded ? '−' : '+'}</ToggleIcon>
      </ItemHeader>

      {expanded && (
        <ItemBody>
          <ItemMeta>
            <span style={{ fontSize: '0.75rem', opacity: 0.65 }}>
              {playlistEntry
                ? isActive
                  ? 'Aktiv in der Playlist'
                  : 'In der Playlist deaktiviert'
                : 'Nicht in der Playlist'}
            </span>
            {needsCategory && <Warning>Kategorie fehlt</Warning>}
          </ItemMeta>
          <Preview
            ref={videoRef}
            src={`/api/v1/videos/${encodeURIComponent(video.name)}/stream`}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => {
              e.currentTarget.volume = 0.2;
            }}
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
              Entfernen
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={saveTranscript}
              disabled={saving}
            >
              {saving ? 'Speichert…' : 'Transcript speichern'}
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
}) {
  return (
    <CollapsiblePanel storageKey="library" title="Medienbibliothek">
      <Tabs>
        <Button
          variant={libraryTab === 'uploads' ? 'primary' : 'ghost'}
          onClick={() => setLibraryTab('uploads')}
        >
          Uploads ({videos.length})
        </Button>
        <Button
          variant={libraryTab === 'vods' ? 'primary' : 'ghost'}
          onClick={() => setLibraryTab('vods')}
        >
          Twitch VODs
        </Button>
      </Tabs>

      {libraryTab === 'uploads' && (
        <>
          <Hint>Dateien werden in der Playlist-Reihenfolge gestreamt.</Hint>
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

          <ItemList>
            {videos.length === 0 && (
              <VideoListEmpty>Noch keine Videos vorhanden.</VideoListEmpty>
            )}
            {videos.map((video) => (
              <MediaLibraryItem
                key={video.name}
                video={video}
                playlistEntry={playlist.find(
                  (entry) => entry.filename === video.name,
                )}
                onRefresh={onRefresh}
                onDelete={onDelete}
                onAddToPlaylist={onAddToPlaylist}
              />
            ))}
          </ItemList>
        </>
      )}

      {libraryTab === 'vods' && user && (
        <>
          <SourceRow>
            <Select
              value={vodSource}
              onChange={(e) => {
                setVodSource(e.target.value);
                if (e.target.value === 'own') {
                  setVodUserLogin(null);
                  setVods([]);
                  setVodsPagination(null);
                  api.saveSettings({ altStreamer: '' }).catch(() => {});
                }
              }}
            >
              <option value="own">Eigene VODs</option>
              <option value="other">Alternativer Streamer VODs</option>
            </Select>

            {vodSource === 'other' && (
              <AltUserForm
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = altUsernameInput.trim();
                  if (!name) return;
                  setVodUserLogin(name);
                  setVods([]);
                  setVodsPagination(null);
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
            {vodSource === 'own' ? (
              <>
                Deine Twitch-Aufzeichnungen. &bdquo;Importieren&ldquo; l&auml;dt
                sie per yt-dlp herunter.
              </>
            ) : vodUserLogin ? (
              <>
                VODs von @{vodUserLogin}. &bdquo;Importieren&ldquo; l&auml;dt
                sie per yt-dlp herunter.
              </>
            ) : (
              <>Benutzernamen eingeben und &bdquo;Laden&ldquo; klicken.</>
            )}
          </Hint>

          {vodSource === 'other' && !vodUserLogin ? null : vodsLoading &&
            vods.length === 0 ? (
            <p style={{ opacity: 0.6 }}>Lade VODs…</p>
          ) : vods.length === 0 ? (
            <p style={{ opacity: 0.6 }}>Keine Aufzeichnungen gefunden.</p>
          ) : (
            <VideoList>
              {vods.map((vod) => {
                const thumbUrl = vod.thumbnail_url
                  ?.replace(/%?\{width\}/g, '320')
                  ?.replace(/%?\{height\}/g, '180');
                return (
                  <VodRow key={vod.id}>
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
                        onError={(e) =>
                          (e.currentTarget.style.display = 'none')
                        }
                      />
                    )}
                    <VideoListName
                      style={{ flex: '1 1 60%' }}
                      title={vod.title}
                    >
                      {vod.title}
                    </VideoListName>
                    <VideoListSize
                      style={{
                        fontSize: '0.75rem',
                        opacity: 0.65,
                        flex: '1 1 100%',
                      }}
                    >
                      {formatVodDuration(vod.duration)} ·{' '}
                      {new Date(vod.created_at).toLocaleDateString()}
                    </VideoListSize>
                    {vod.importStatus === 'ready' ? (
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          fontSize: '0.875rem',
                          color: 'var(--color-success, #4caf50)',
                        }}
                      >
                        <span className="material-symbols-outlined small">
                          download_done
                        </span>{' '}
                        Importiert
                      </span>
                    ) : vod.importStatus === 'downloading' ? (
                      <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                        ⏳ Wird geladen…
                      </span>
                    ) : vod.importStatus === 'error' ? (
                      <Button
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                        variant="ghost"
                        danger
                        onClick={() => onImportVod(vod)}
                      >
                        <span className="material-symbols-outlined small">
                          file_download_off
                        </span>{' '}
                        Wiederholen
                      </Button>
                    ) : (
                      <Button
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                        variant="ghost"
                        onClick={() => onImportVod(vod)}
                      >
                        <span className="material-symbols-outlined small">
                          download
                        </span>{' '}
                        Importieren
                      </Button>
                    )}
                  </VodRow>
                );
              })}
            </VideoList>
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
    </CollapsiblePanel>
  );
}

const Tabs = styled.div`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
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
`;

const ItemRow = styled(VideoListItem)`
  display: block;
  padding: 0;
  overflow: hidden;
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
`;

const StatusDot = styled.span`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $active }) =>
    $active ? 'var(--color-success, #4caf50)' : '#666'};
  box-shadow: ${({ $active }) =>
    $active ? '0 0 0 3px rgba(76,175,80,.16)' : 'none'};
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

const ItemActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
`;
