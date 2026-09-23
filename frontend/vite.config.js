import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development, /api requests are forwarded to the Node backend
// so the frontend can just call fetch('/api/...') everywhere.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
    // Serve index.html for all non-asset routes so /app doesn't 404 in dev.
    historyApiFallback: true,
  },
});
