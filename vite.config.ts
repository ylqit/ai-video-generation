import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 4311,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310', '/productions': 'http://127.0.0.1:4310' },
  },
  build: { outDir: 'dist/web' },
});
