import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  server: {
    port: 5173,
    host: true, // permite abrirlo desde el celular en la misma wifi
  },
});
