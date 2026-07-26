// Service worker de Movi.
//
// Estrategia: SIEMPRE network-first para HTML/JS/CSS. Nunca cache-first en
// estos archivos — ya tuvimos versiones viejas serviditas desde cache que
// causaron bugs dificiles de diagnosticar. El cache solo actua como
// respaldo para cuando no hay conexion.
//
// Para forzar que todos los celulares bajen la version nueva, subir a mano
// este numero (borra el cache viejo en el evento 'activate').
const CACHE_VERSION = 'movi-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) => Promise.all(
      nombres
        .filter((nombre) => nombre !== CACHE_VERSION)
        .map((nombre) => caches.delete(nombre)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo interceptamos GET dentro del mismo origen (no Mapbox/Supabase/etc).
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copia));
        return respuesta;
      })
      .catch(() => caches.match(request)),
  );
});
