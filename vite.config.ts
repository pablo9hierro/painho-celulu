import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.PN_API_PORT ?? 5174);

export default defineConfig({
  plugins: [react()],
  // som do encerramento embutido no app
  assetsInclude: ['**/*.m4a'],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    // pastas com vídeos grandes (testes, mídia do usuário, exportações): não vigiar
    watch: { ignored: ['**/e2e/**', '**/test-results/**', '**/data/**', '**/brand/**', '**/android/**', '**/dist/**'] },
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
});
