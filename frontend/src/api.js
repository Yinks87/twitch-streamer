const BASE = '/api/v1';
import axios from 'axios';

async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error || `Request failed with status ${res.status}`);
  return data;
}

const apiClient = axios.create({
  baseURL: BASE,
});

export const api = {
  // Auth
  getMe: () => apiClient.get(`/auth/me`).then((res) => res.data),
  logout: () => apiClient.post(`/auth/logout`, {}).then((res) => res.data),
  loginUrl: `${BASE}/auth/twitch`,

  // Settings
  getSettings: () => apiClient.get(`/settings`).then((res) => res.data),
  saveSettings: (payload) =>
    apiClient.post(`/settings`, payload).then((res) => res.data),

  // User management
  getManagers: () => apiClient.get(`/users/managers`).then((res) => res.data),
  addManager: (login, role) =>
    apiClient.post(`/users/managers`, { login, role }).then((res) => res.data),
  removeManager: (id) =>
    apiClient.delete(`/users/managers/${id}`).then((res) => res.data),

  // Videos
  getVideos: () => apiClient.get(`/videos`).then((res) => res.data),
  deleteVideo: (name) =>
    apiClient
      .delete(`/videos/${encodeURIComponent(name)}`)
      .then((res) => res.data),
  updateTranscript: (name, transcript) =>
    apiClient
      .put(`/videos/${encodeURIComponent(name)}/transcript`, transcript)
      .then((res) => res.data),
  uploadVideos: (files, metaList) => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('videos', file));
    if (metaList) form.append('meta', JSON.stringify(metaList));
    return fetch(`/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    }).then(handle);
  },

  // Active downloads
  getDownloads: () => apiClient.get(`/downloads`).then((res) => res.data),
  abortDownload: (entryId) =>
    apiClient.delete(`/downloads/${entryId}`).then((res) => res.data),

  // Twitch VODs
  getVods: (after, userLogin) => {
    const p = new URLSearchParams();
    if (after) p.set('after', after);
    if (userLogin) p.set('user_login', userLogin);
    const qs = p.toString();
    return apiClient
      .get(`/twitch/vods${qs ? `?${qs}` : ''}`)
      .then((res) => res.data);
  },
  importVod: (id, title) =>
    apiClient
      .post(`/twitch/vods/${id}/import`, { title })
      .then((res) => res.data),
  searchCategories: (query) =>
    apiClient
      .get(`/twitch/categories?query=${encodeURIComponent(query)}`)
      .then((res) => res.data),

  // Playlist
  getPlaylist: () => apiClient.get(`/playlist`).then((res) => res.data),
  addToPlaylist: (filename) =>
    apiClient.post(`/playlist`, { filename }).then((res) => res.data),
  removeFromPlaylist: (id) =>
    apiClient.delete(`/playlist/${id}`).then((res) => res.data),
  reorderPlaylist: (ids) =>
    apiClient.put(`/playlist/reorder`, { ids }).then((res) => res.data),
  togglePlaylistEntry: (id, enabled) =>
    apiClient.patch(`/playlist/${id}`, { enabled }).then((res) => res.data),

  // Stream
  getStatus: () => apiClient.get(`/stream/status`).then((res) => res.data),
  startStream: () =>
    apiClient.post(`/stream/start`, {}).then((res) => res.data),
  stopStream: () => apiClient.post(`/stream/stop`, {}).then((res) => res.data),

  // Stream logs (admin only)
  getLogFiles: () => apiClient.get(`/stream/logs`).then((res) => res.data),
  getLogFile: (filename) =>
    apiClient
      .get(`/stream/logs/${encodeURIComponent(filename)}`)
      .then((res) => res.data),
  getLogFileDownloadUrl: (filename) =>
    `/stream/logs/${encodeURIComponent(filename)}/download`,
  deleteLogFile: (filename) =>
    apiClient
      .delete(`/stream/logs/${encodeURIComponent(filename)}`)
      .then((res) => res.data),
};
