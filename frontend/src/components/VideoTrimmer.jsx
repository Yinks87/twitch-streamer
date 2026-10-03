import { useEffect, useRef, useState } from 'react';
import Button from './Button';
import { api } from '../api';
import { useAlert } from '../context/AlertContext';

function formatDuration(totalSeconds) {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Twitch reports muted stretches as {offset, duration}; cut ranges use {start, end}.
function mutedToRange(seg) {
  return { start: seg.offset, end: seg.offset + seg.duration };
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function rangesEqual(a, b) {
  return Math.abs(a.start - b.start) < 0.25 && Math.abs(a.end - b.end) < 0.25;
}

// ── Cuts a video directly in the browser's Mediathek: pick ranges on a timeline
// (including one click for Twitch's reported muted/copyright stretches), then
// confirm a destructive "original gets replaced" dialog before calling the API. ──
export default function VideoTrimmer({ duration, mutedSegments = [], onTrim, videoName }) {
  const { showAlert } = useAlert();
  const [cutRanges, setCutRanges] = useState([]);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const trackRef = useRef(null);
  const dragRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const hasDuration = Number.isFinite(duration) && duration > 0;
  const mutedRanges = mutedSegments.map(mutedToRange);
  const selectableMutedRanges = mutedRanges.filter(
    (range) => range.end - range.start >= 0.3,
  );
  const allMutedRangesSelected =
    selectableMutedRanges.length > 0 &&
    selectableMutedRanges.every((range) =>
      cutRanges.some((selected) => rangesEqual(selected, range)),
    );

  function clientXToSeconds(clientX) {
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function addRange(range) {
    if (range.end - range.start < 0.3) return;
    setCutRanges((prev) => [...prev, range].sort((a, b) => a.start - b.start));
  }

  function removeRange(index) {
    setCutRanges((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleMutedRange(range) {
    const existingIndex = cutRanges.findIndex((r) => rangesEqual(r, range));
    if (existingIndex >= 0) {
      removeRange(existingIndex);
    } else {
      addRange(range);
    }
  }

  function toggleAllMutedRanges() {
    setCutRanges((current) => {
      if (
        selectableMutedRanges.length > 0 &&
        selectableMutedRanges.every((range) =>
          current.some((selected) => rangesEqual(selected, range)),
        )
      ) {
        return current.filter(
          (selected) =>
            !selectableMutedRanges.some((range) => rangesEqual(selected, range)),
        );
      }

      const next = [...current];
      for (const range of selectableMutedRanges) {
        if (!next.some((selected) => rangesEqual(selected, range))) {
          next.push(range);
        }
      }
      return next.sort((a, b) => a.start - b.start);
    });
  }

  function handlePointerDown(e) {
    if (!hasDuration) return;
    const start = clientXToSeconds(e.clientX);
    dragRef.current = { start, current: start };
    // force a re-render so the live preview block shows up
    setCutRanges((prev) => [...prev]);
  }

  function handlePointerMove(e) {
    if (!dragRef.current) return;
    dragRef.current.current = clientXToSeconds(e.clientX);
    setCutRanges((prev) => [...prev]);
  }

  function handlePointerUp() {
    if (!dragRef.current) return;
    const { start, current } = dragRef.current;
    dragRef.current = null;
    addRange({
      start: Math.min(start, current),
      end: Math.max(start, current),
    });
  }

  const liveDrag = dragRef.current
    ? {
        start: Math.min(dragRef.current.start, dragRef.current.current),
        end: Math.max(dragRef.current.start, dragRef.current.current),
      }
    : null;

  const totalCut = cutRanges.reduce((sum, r) => sum + (r.end - r.start), 0);

  async function handleConfirm() {
    // Close the confirmation dialog right away — the processing indicator below
    // takes over for the (potentially long) ffmpeg re-encode.
    setConfirming(false);
    setSaving(true);
    setProgress(0);
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.getTrimProgress(videoName);
        if (typeof data.progress === 'number') setProgress(data.progress);
      } catch {
        // keep showing the last known percentage if a poll request fails
      }
    }, 700);
    try {
      await onTrim(cutRanges);
      setCutRanges([]);
    } catch (err) {
      showAlert({ severity: 'error', message: err.message });
    } finally {
      clearInterval(pollRef.current);
      setSaving(false);
      setProgress(null);
    }
  }

  if (!hasDuration) return null;

  if (saving) {
    const percent = progress != null ? Math.max(0, Math.min(100, progress)) : null;
    return (
      <div
        style={{
          marginTop: '0.75rem',
          padding: '0.6rem 0.7rem',
          borderRadius: '6px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid #2a2a3e',
        }}
      >
        <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
          Video wird geschnitten… das kann je nach Länge einen Moment dauern.
        </div>
        <div
          style={{
            background: '#333',
            borderRadius: '3px',
            height: '6px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              background: '#9147ff',
              transition: 'width 0.4s',
              width: `${percent ?? 0}%`,
            }}
          />
        </div>
        <div style={{ marginTop: '0.25rem', fontSize: '0.72rem', opacity: 0.55 }}>
          {percent != null ? `${percent.toFixed(1)}%` : 'Starte…'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.3rem',
        }}
      >
        <span style={{ fontSize: '0.8rem', opacity: 0.75 }}>
          Schnitt (klicken + ziehen, um einen Bereich zu entfernen)
        </span>
        {mutedRanges.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Button
                type="button"
                variant="ghost"
                onClick={toggleAllMutedRanges}
                style={{ padding: '0.2rem 0.45rem', fontSize: '0.72rem' }}
                title={
                  allMutedRangesSelected
                    ? 'Alle Twitch-Stummschaltungen aus der Schnittliste entfernen'
                    : 'Alle Twitch-Stummschaltungen zum Schnitt hinzufügen'
                }
              >
                <span className="material-symbols-outlined small">content_cut</span>
                {allMutedRangesSelected ? 'Alle entfernen' : 'Alle markieren'}
              </Button>
              <span style={{ fontSize: '0.72rem', opacity: 0.6 }}>
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '10px',
                background: '#b23b3b',
                borderRadius: '2px',
                marginRight: '4px',
                verticalAlign: 'middle',
              }}
            />
            von Twitch stummgeschaltet
            </span>
          </div>
        )}
      </div>

      <div
        ref={trackRef}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={() => {
          if (dragRef.current) handlePointerUp();
        }}
        style={{
          position: 'relative',
          height: '28px',
          background: 'rgba(255,255,255,0.06)',
          borderRadius: '4px',
          cursor: 'col-resize',
          userSelect: 'none',
        }}
      >
        {mutedRanges.map((range, i) => (
          <div
            key={`muted-${i}`}
            title={`Stummgeschaltet: ${formatDuration(range.start)} – ${formatDuration(range.end)} (klicken zum Markieren)`}
            onMouseDown={(e) => {
              e.stopPropagation();
              toggleMutedRange(range);
            }}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(range.start / duration) * 100}%`,
              width: `${Math.max(0.3, ((range.end - range.start) / duration) * 100)}%`,
              background: 'repeating-linear-gradient(45deg, #b23b3b, #b23b3b 4px, #8a2c2c 4px, #8a2c2c 8px)',
              opacity: cutRanges.some((r) => rangesOverlap(r, range)) ? 0.45 : 0.85,
              cursor: 'pointer',
            }}
          />
        ))}

        {cutRanges.map((range, i) => (
          <div
            key={`cut-${i}`}
            title="Klicken zum Entfernen"
            onMouseDown={(e) => {
              e.stopPropagation();
              removeRange(i);
            }}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(range.start / duration) * 100}%`,
              width: `${Math.max(0.3, ((range.end - range.start) / duration) * 100)}%`,
              background: 'var(--signal, #e05d44)',
              opacity: 0.75,
              cursor: 'pointer',
            }}
          />
        ))}

        {liveDrag && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(liveDrag.start / duration) * 100}%`,
              width: `${Math.max(0.1, ((liveDrag.end - liveDrag.start) / duration) * 100)}%`,
              background: 'var(--signal, #e05d44)',
              opacity: 0.45,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {cutRanges.length > 0 && (
        <div style={{ marginTop: '0.4rem' }}>
          {cutRanges.map((range, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.78rem',
                fontFamily: 'monospace',
                padding: '0.15rem 0',
              }}
            >
              <span>
                {formatDuration(range.start)} – {formatDuration(range.end)}
              </span>
              <span style={{ opacity: 0.6 }}>
                ({formatDuration(range.end - range.start)})
              </span>
              <Button
                type="button"
                variant="ghost"
                danger
                onClick={() => removeRange(i)}
                style={{ padding: '0 0.4rem', fontSize: '0.72rem' }}
              >
                <span className="material-symbols-outlined small">delete</span>
              </Button>
            </div>
          ))}
          <div style={{ fontSize: '0.75rem', opacity: 0.65, marginTop: '0.2rem' }}>
            Entfernt: {formatDuration(totalCut)} · Neue Länge:{' '}
            {formatDuration(duration - totalCut)}
          </div>
        </div>
      )}

      <div style={{ marginTop: '0.5rem' }}>
        <Button
          type="button"
          variant="ghost"
          disabled={cutRanges.length === 0}
          onClick={() => setConfirming(true)}
        >
          <span className="material-symbols-outlined small">content_cut</span>{' '}
          Schneiden…
        </Button>
      </div>

      {confirming && (
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
          onClick={() => setConfirming(false)}
        >
          <div
            style={{
              background: 'var(--surface, #1a1a2e)',
              borderRadius: '8px',
              padding: '1.5rem',
              width: 'min(440px,92vw)',
              boxShadow: '0 8px 32px rgba(0,0,0,.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 0.75rem' }}>Video schneiden?</h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', lineHeight: 1.5 }}>
              Das Original wird dabei <strong>unwiderruflich gelöscht</strong> und
              durch die geschnittene Fassung ersetzt. Es entstehen keine zwei
              Versionen — stelle sicher, dass du das Original nicht mehr brauchst.
            </p>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                justifyContent: 'flex-end',
                marginTop: '1.25rem',
              }}
            >
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Abbrechen
              </Button>
              <Button type="button" variant="primary" onClick={handleConfirm}>
                Original löschen & schneiden
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
