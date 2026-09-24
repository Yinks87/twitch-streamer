import { useEffect, useState } from 'react';
import { api } from '../api';
import { defaultTimestamp } from '../utils/transcript';
import Button from './Button';
import { Input } from './FormControls';

// ── Shared: hh:mm:ss input masking ───────────────────────────────────────────
function clampSegment(segment, max) {
  if (segment.length < 2) return segment;
  const num = parseInt(segment, 10);
  if (Number.isNaN(num)) return segment;
  return String(Math.min(num, max)).padStart(2, '0');
}

// Strips anything that isn't a digit and progressively re-inserts the hh:mm:ss colons,
// clamping minutes/seconds to 0-59 as soon as both of their digits are present.
function maskTimeInput(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  const hh = digits.slice(0, 2);
  const mm = clampSegment(digits.slice(2, 4), 59);
  const ss = clampSegment(digits.slice(4, 6), 59);
  return [hh, mm, ss].filter((segment) => segment.length > 0).join(':');
}

// Pads an in-progress hh:mm:ss value to a full, valid timestamp on blur.
function completeTimeInput(raw) {
  const digits = raw.replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
  const hh = digits.slice(0, 2);
  const mm = clampSegment(digits.slice(2, 4), 59);
  const ss = clampSegment(digits.slice(4, 6), 59);
  return `${hh}:${mm}:${ss}`;
}

// ── Shared: Category autocomplete input ──────────────────────────────────────
function CategoryInput({ value = '', onChange }) {
  const [inputValue, setInputValue] = useState(value || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if ((value || '') !== inputValue) {
      setInputValue(value || '');
      setSearchQuery('');
    }
  }, [value, inputValue]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setActiveIndex(-1);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const d = await api.searchCategories(query);
        setSuggestions(d.data || []);
        setActiveIndex(-1);
        setOpen(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  function pick(s) {
    setInputValue(s.name);
    setSearchQuery('');
    onChange(s.name, s.id);
    setSuggestions([]);
    setActiveIndex(-1);
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      pick(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const query = (inputValue || '').trim();
  const showNoResults =
    open && !loading && query.length >= 2 && suggestions.length === 0;

  return (
    <div className="category-input" style={{ position: 'relative' }}>
      <Input
        type="text"
        value={inputValue}
        onChange={(e) => {
          const nextValue = e.target.value;
          setInputValue(nextValue);
          setSearchQuery(nextValue);
          onChange(nextValue, null);
          setOpen(true);
        }}
        onFocus={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder="Kategorie suchen…"
        autoComplete="off"
        style={{ width: '100%' }}
      />
      {open && (suggestions.length > 0 || loading || showNoResults) && (
        <ul
          className="category-input__list"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 50,
            maxHeight: '220px',
            overflowY: 'auto',
            background: 'var(--surface, #1a1a2e)',
            border: '1px solid #444',
            borderRadius: '4px',
            listStyle: 'none',
            margin: '2px 0 0',
            padding: 0,
          }}
        >
          {loading && (
            <li style={{ padding: '0.4rem 0.75rem', opacity: 0.6 }}>
              Suche&hellip;
            </li>
          )}
          {!loading && showNoResults && (
            <li style={{ padding: '0.4rem 0.75rem', opacity: 0.6 }}>
              Keine Kategorien gefunden
            </li>
          )}
          {!loading &&
            suggestions.map((s, idx) => (
              <li
                key={s.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
                style={{
                  padding: '0.4rem 0.75rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  background:
                    idx === activeIndex
                      ? 'rgba(255,255,255,0.08)'
                      : 'transparent',
                }}
              >
                {s.box_art_url && (
                  <img
                    src={s.box_art_url
                      .replace('{width}', '20')
                      .replace('{height}', '27')}
                    alt=""
                    style={{
                      width: 20,
                      height: 27,
                      objectFit: 'cover',
                      borderRadius: '2px',
                      flexShrink: 0,
                    }}
                  />
                )}
                {s.name}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

// ── Shared: single timestamp card (collapsed row / expanded editor) ──────────
function TimestampCard({ timestamp, index, storageKey, onChange, onRemove }) {
  const [expanded, setExpanded] = useState(
    () => window.localStorage.getItem(storageKey) === 'expanded',
  );

  useEffect(() => {
    window.localStorage.setItem(
      storageKey,
      expanded ? 'expanded' : 'collapsed',
    );
  }, [expanded, storageKey]);

  return (
    <div
      style={{
        border: '1px solid #2a2a3e',
        borderRadius: '6px',
        marginBottom: '0.5rem',
        background: 'rgba(255,255,255,0.035)',
        overflow: 'visible',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.65rem',
          width: '100%',
          minHeight: '46px',
          padding: '0.6rem 0.7rem',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '1.2rem',
            color: 'var(--text-dim, #8d9198)',
            fontFamily: 'monospace',
            fontSize: '1.1rem',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              transition: 'transform 0.1s ease-in-out',
              transform: expanded ? 'rotate(90deg)' : 'rotate(270deg)',
            }}
            class="material-symbols-outlined small"
          >
            arrow_forward_ios
          </span>
        </span>
        <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>
          {timestamp.time || '00:00:00'}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {timestamp.title || timestamp.category || 'Neuer Timestamp'}
        </span>
        {timestamp.category && (
          <span
            style={{
              marginLeft: 'auto',
              opacity: 0.55,
              fontSize: '0.78rem',
              flexShrink: 0,
            }}
          >
            {timestamp.category}
          </span>
        )}
      </button>

      {expanded && (
        <div style={{ padding: '0 0.7rem 0.7rem' }}>
          <div
            style={{
              display: 'flex',
              gap: '0.35rem',
              marginBottom: '0.4rem',
              alignItems: 'center',
            }}
          >
            <Input
              type="text"
              value={timestamp.title}
              onChange={(e) => onChange({ title: e.target.value })}
              placeholder="Titel"
              style={{ flex: 1 }}
              maxLength={140}
              title="Titel (max. 140 Zeichen)"
            />
            {index > 0 && (
              <Button
                type="button"
                variant="ghost"
                danger
                onClick={onRemove}
                style={{ fontSize: '0.75rem', flexShrink: 0 }}
              >
                <span class="material-symbols-outlined small">delete</span>
              </Button>
            )}
          </div>
          <div
            style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}
          >
            <Input
              type="text"
              inputMode="numeric"
              value={timestamp.time ?? '00:00:00'}
              onChange={(e) =>
                onChange({ time: maskTimeInput(e.target.value) })
              }
              onBlur={(e) =>
                onChange({ time: completeTimeInput(e.target.value) })
              }
              style={{ width: '92px', fontFamily: 'monospace', flexShrink: 0 }}
              placeholder="hh:mm:ss"
              title="Zeit (hh:mm:ss)"
            />
            <div style={{ flex: 1 }}>
              <CategoryInput
                value={timestamp.category}
                onChange={(value, categoryId) =>
                  onChange({ category: value, category_id: categoryId ?? null })
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Formats a player's currentTime (seconds, possibly fractional) as hh:mm:ss.
function secondsToTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ── Shared: Timestamp list editor ─────────────────────────────────────────────
export default function TimestampEditor({
  timestamps,
  onChange,
  storageKeyPrefix = 'default',
  getCurrentTime,
}) {
  function add() {
    const prev = timestamps[timestamps.length - 1] || defaultTimestamp();
    const liveSeconds = getCurrentTime?.();
    const time = Number.isFinite(liveSeconds)
      ? secondsToTimestamp(liveSeconds)
      : prev.time;
    onChange([...timestamps, { ...prev, time }]);
  }
  function remove(i) {
    onChange(timestamps.filter((_, idx) => idx !== i));
  }
  // batch multiple field updates into one onChange call to avoid stale-closure overwrites
  function updateFields(i, fields) {
    onChange(timestamps.map((t, idx) => (idx === i ? { ...t, ...fields } : t)));
  }

  return (
    <div style={{ marginTop: '0.5rem' }}>
      {timestamps.map((ts, i) => (
        <TimestampCard
          key={i}
          timestamp={ts}
          index={i}
          storageKey={`twitch-streamer.timestamp.${storageKeyPrefix}.${i}`}
          onChange={(fields) => updateFields(i, fields)}
          onRemove={() => remove(i)}
        />
      ))}
      <Button
        type="button"
        variant="ghost"
        onClick={add}
        style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}
      >
        + Timestamp
      </Button>
    </div>
  );
}
