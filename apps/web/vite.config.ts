import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const proxyTarget = process.env.API_PROXY_TARGET || 'http://localhost:3000';

const proxy = {
  '/api': {
    target: proxyTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy,
  },
});
