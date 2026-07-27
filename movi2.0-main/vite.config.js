import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  server: {
    port: 5173,
    host: true, // permite abrirlo desde el celular en la misma wifi
  },
  define: {
    // Timestamp de cuando se compilo esta version — se usa para
    // detectar automaticamente cuando hay una version mas nueva
    // desplegada y refrescar solo, sin depender de que alguien borre
    // cache a mano.
    __APP_BUILD__: JSON.stringify(String(Date.now())),
  },
});
