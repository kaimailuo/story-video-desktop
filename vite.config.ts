import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [react(), {
    name: 'renderer-content-security-policy',
    transformIndexHtml(html) {
      return html.replace('__SCRIPT_POLICY__', command === 'serve' ? "'self' 'unsafe-inline'" : "'self'")
        .replace('__CONNECT_POLICY__', command === 'serve' ? "'self' ws://127.0.0.1:*" : "'self'");
    },
  }],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
