import express from 'express';
import * as db from '../../db.js';
import { refreshActivePlaylist } from '../../streamManager.js';
import { readTranscript, transcriptNeedsCategory } from '../../utils/transcript.js';

const playlistRouter = express.Router();

async function refreshRunningPlaylist() {
  try {
    return await refreshActivePlaylist();
  } catch (error) {
    console.error('Unable to refresh active playlist:', error.message);
    return false;
  }
}

playlistRouter.get('/playlist', (req, res) => {
  const playlist = db.getPlaylist().map((entry) => ({
    ...entry,
    needsCategory: transcriptNeedsCategory(readTranscript(entry.filename)),
  }));
  res.json({ playlist });
});

playlistRouter.post('/playlist', async (req, res) => {
  const filename = String(req.body?.filename || '').trim();
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  const existing = db.getPlaylistEntryByFilename(filename);
  if (existing) return res.json({ entry: existing, alreadyExists: true });

  const transcript = readTranscript(filename);
  if (!transcript) return res.status(404).json({ error: 'Video transcript not found' });

  const first = transcript.timestamps?.[0] || {};
  const entry = db.addPlaylistEntry({
    source: transcript.source === 'vod' ? 'vod' : 'upload',
    title: first.title || filename,
    filename,
    vodId: transcript.vodId || null,
    enabled: !transcriptNeedsCategory(transcript),
  });
  res.status(201).json({ entry, playlistRefreshed: await refreshRunningPlaylist() });
});

playlistRouter.delete('/playlist/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  db.removePlaylistEntry(id);
  res.json({ ok: true, playlistRefreshed: await refreshRunningPlaylist() });
});

playlistRouter.put('/playlist/reorder', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const numericIds = ids.map(Number);
  if (numericIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'ids must contain integers' });
  }
  const playlist = db.reorderPlaylist(numericIds).map((entry) => ({
    ...entry,
    needsCategory: transcriptNeedsCategory(readTranscript(entry.filename)),
  }));
  res.json({ ok: true, playlist, playlistRefreshed: await refreshRunningPlaylist() });
});

playlistRouter.patch('/playlist/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const { enabled } = req.body || {};
  if (typeof enabled === 'number' || typeof enabled === 'boolean') {
    if (enabled) {
      const entry = db.getPlaylist().find((e) => e.id === id);
      if (entry && transcriptNeedsCategory(readTranscript(entry.filename))) {
        return res.status(400).json({
          error: 'Transkript ist unvollständig (Kategorie fehlt) und kann nicht aktiviert werden.',
        });
      }
    }
    db.updatePlaylistEntry(id, { enabled: enabled ? 1 : 0 });
  }
  res.json({ ok: true, playlistRefreshed: await refreshRunningPlaylist() });
});

export default playlistRouter;
