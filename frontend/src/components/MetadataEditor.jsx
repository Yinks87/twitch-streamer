import { useState } from 'react';
import { api } from '../api';
import TimestampEditor from './TimestampEditor';
import { defaultTimestamp, normalizeTranscript } from '../utils/transcript';
import Button from './Button';

// ── Metadata editor (for existing videos / active downloads) ──────────────────
export default function MetadataEditor({ filename, initialTranscript, onSave, onClose }) {
  const seed = normalizeTranscript(initialTranscript || {}).timestamps;
  const [timestamps, setTimestamps] = useState(seed);
  const [saving, setSaving] = useState(false);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = normalizeTranscript({
        timestamps: timestamps.length ? timestamps : [defaultTimestamp()],
      });
      await api.updateTranscript(filename, payload);
      onSave?.();
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.75)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--surface, #1a1a2e)',
          borderRadius: '8px',
          padding: '1.5rem',
          width: 'min(520px,92vw)',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 1rem' }}>Metadaten bearbeiten</h3>
        <p
          style={{
            fontSize: '0.75rem',
            opacity: 0.5,
            margin: '0 0 1rem',
            fontFamily: 'monospace',
          }}
        >
          {filename}
        </p>
        <form onSubmit={handleSave}>
          <TimestampEditor
            timestamps={timestamps}
            onChange={setTimestamps}
            storageKeyPrefix={`metadata.${filename}`}
          />
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'flex-end',
              marginTop: '1.25rem',
            }}
          >
            <Button type="button" variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Speichert…' : 'Speichern'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
