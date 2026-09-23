const BASE = '/api/v1';
import axios from 'axios';

async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);
  return data;
}

const apiClient = axios.create({
  baseURL: BASE,
})

const get = (url) => fetch(url, { credentials: 'include' }).then(handle);
const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle);
const del = (url) => fetch(url, { method: 'DELETE', credentials: 'include' }).then(handle);
const patch = (url, body) =>
  fetch(url, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle);
const put = (url, body) =>
  fetch(url, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle);

export const api = {
  // Auth
  getMe: () => get(`${BASE}/auth/me`),
  logout: () => post(`${BASE}/auth/logout`, {}),
  // loginUrl redirects the browser to start the OAuth flow
  loginUrl: `${BASE}/auth/twitch`,

  // Settings
  getSettings: () => get(`${BASE}/settings`),
  saveSettings: (payload) => post(`${BASE}/settings`, payload),

  // User management
  getManagers: () => get(`${BASE}/users/managers`),
  addManager: (login, role) => post(`${BASE}/users/managers`, { login, role }),
  removeManager: (id) => del(`${BASE}/users/managers/${id}`),

  // Videos
  getVideos: () => get(`${BASE}/videos`),
  deleteVideo: (name) => del(`${BASE}/videos/${encodeURIComponent(name)}`),
  updateTranscript: (name, transcript) => put(`${BASE}/videos/${encodeURIComponent(name)}/transcript`, transcript),
  uploadVideos: (files, metaList) => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('videos', file));
    if (metaList) form.append('meta', JSON.stringify(metaList));
    return fetch(`${BASE}/upload`, { method: 'POST', credentials: 'include', body: form }).then(handle);
  },

  // Active downloads
  getDownloads: () => get(`${BASE}/downloads`),
  abortDownload: (entryId) => del(`${BASE}/downloads/${entryId}`),

  // Twitch VODs
  getVods: (after, userLogin) => {
    const p = new URLSearchParams();
    if (after) p.set("after", after);
    if (userLogin) p.set("user_login", userLogin);
    const qs = p.toString();
    return get(`${BASE}/twitch/vods${qs ? `?${qs}` : ""}`);
  },
  importVod: (id, title) => post(`${BASE}/twitch/vods/${id}/import`, { title }),
  searchCategories: (query) => get(`${BASE}/twitch/categories?query=${encodeURIComponent(query)}`),

  // Playlist
  getPlaylist: () => get(`${BASE}/playlist`),
  addToPlaylist: (filename) => post(`${BASE}/playlist`, { filename }),
  removeFromPlaylist: (id) => del(`${BASE}/playlist/${id}`),
  reorderPlaylist: (ids) => put(`${BASE}/playlist/reorder`, { ids }),
  togglePlaylistEntry: (id, enabled) => patch(`${BASE}/playlist/${id}`, { enabled }),

  // Stream
  getStatus: () => get(`${BASE}/stream/status`),
  startStream: () => post(`${BASE}/stream/start`, {}),
  stopStream: () => post(`${BASE}/stream/stop`, {}),
};

