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
      .catch(() => caches.match(request).then((cacheada) => {
        // FIX: caches.match() devuelve undefined si no hay nada guardado
        // para esta URL todavia (ej: primera visita sin conexion). Devolver
        // undefined desde respondWith() rompe el fetch entero con
        // "Failed to convert value to 'Response'" — hay que devolver SIEMPRE
        // un Response real, aunque sea una de error generica.
        if (cacheada) return cacheada;
        return new Response('Sin conexión y sin version en cache todavia.', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })),
  );
});
