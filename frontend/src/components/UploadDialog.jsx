import { useState } from 'react';
import styled from '@emotion/styled';
import TimestampEditor from './TimestampEditor';
import { defaultTimestamp, normalizeTranscript } from '../utils/transcript';
import Button from './Button';

// ── Upload dialog ─────────────────────────────────────────────────────────────
export default function UploadDialog({ files, onClose, onUpload }) {
  const [items, setItems] = useState(() =>
    files.map((f, i) => ({
      id: i,
      file: f,
      addToPlaylist: true,
      timestamps: [
        {
          ...defaultTimestamp(),
          title: f.name.replace(/\.[^.]+$/, ''),
        },
      ],
    })),
  );

  function updateTimestamps(id, ts) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, timestamps: ts } : it)),
    );
  }

  function handleSubmit(e) {
    e.preventDefault();
    const metaList = items.map(({ timestamps, addToPlaylist }) => ({
      ...normalizeTranscript({
        timestamps: timestamps.length ? timestamps : [defaultTimestamp()],
      }),
      addToPlaylist,
    }));
    onUpload(
      items.map((it) => it.file),
      metaList,
    );
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
          width: 'min(640px,92vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 1.25rem' }}>Videos hochladen</h3>
        <form onSubmit={handleSubmit}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                border: '1px solid #333',
                borderRadius: '6px',
                padding: '0.75rem',
                marginBottom: '0.75rem',
              }}
            >
              <p
                style={{
                  margin: '0 0 0.6rem',
                  fontSize: '0.8rem',
                  opacity: 0.6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.file.name}
              </p>
              <Field
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={item.addToPlaylist}
                  onChange={(e) =>
                    setItems((prev) =>
                      prev.map((it) =>
                        it.id === item.id
                          ? { ...it, addToPlaylist: e.target.checked }
                          : it,
                      ),
                    )
                  }
                />
                <span>Automatisch zur Playlist hinzufügen</span>
              </Field>
              <TimestampEditor
                timestamps={item.timestamps}
                onChange={(ts) => updateTimestamps(item.id, ts)}
                storageKeyPrefix={`upload.${item.id}`}
              />
            </div>
          ))}
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'flex-end',
              marginTop: '0.75rem',
            }}
          >
            <Button type="button" variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" variant="primary">
              {items.length} Datei(en) hochladen
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
  color: var(--text-dim);
`;
