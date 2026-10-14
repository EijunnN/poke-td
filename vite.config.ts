import { defineConfig } from 'vite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Huella de la versión publicada: va dentro del código y en dist/version.json.
// Los jugadores miran ese archivo cada 5 min y, si cambia, el juego se
// actualiza solo (ver src/core/updater.ts).
const VERSION = Date.now().toString(36);

export default defineConfig(({ command, mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(command === 'build' ? VERSION : null) },
  // En desarrollo, /api va al servidor Bun (`bun run server`). Las pruebas no lo usan.
  server: mode === 'test' ? {} : { proxy: { '/api': process.env.API_TARGET || 'http://127.0.0.1:8080' } },
  build: {
    // public/assets/ (sprites, fuente, iconos) se copia tal cual a dist/assets/:
    // lo empaquetado va aparte para no mezclarse.
    assetsDir: 'build',
    target: 'es2022',
  },
  plugins: [{
    name: 'version-json',
    apply: 'build',
    closeBundle() {
      writeFileSync(join(__dirname, 'dist', 'version.json'), JSON.stringify({ v: VERSION, at: new Date().toISOString() }) + '\n');
    },
  }],
}));
