# Bugs conocidos / errores a NO repetir

## De la versión anterior (proyecto reiniciado por esto)

1. `mousedown` en vez de `pointerdown`/`click` en elementos tactiles.
2. z-index hardcodeado o inyectado por JS (`style.zIndex = '99999'`) en vez de las variables de `:root`.
3. Imports que faltan silenciosamente — un modulo bien escrito pero nunca importado no tira error, simplemente no hace nada.
4. `document.addEventListener('DOMContentLoaded', ...)` puede registrarse DESPUES de que el evento ya disparo (con modulos ES, el orden no esta garantizado) — usar el patron: chequear `document.readyState` primero.
5. Búsqueda de Mapbox sin bbox en el fallback trae resultados de otras provincias — el fallback debe ampliar la zona, nunca ir a nivel nacional.

## Encontrados y arreglados en esta etapa (rama fix/driver-pending-trip-route-preview)

- Overlay oscuro tapaba el mapa en la pantalla de espera del conductor (viaje pendiente) — causado por un proceso previo ocupando el puerto 5173 (CSS stale). Fix confirmado en puerto limpio.
- Sheet de pasajero se veía detrás/mezclado con el panel de espera del conductor — algunas rutas mostraban el overlay con `classList` directo en vez de pasar por `mostrarOverlay()`. Se corrigieron dos call sites.
- Auto 3D del conductor quedaba flotando fuera de la calle en vista pitch — problema de referencia de elevación del modelo, corregido en `agregarModeloAuto3D`.
- Estado de viaje pendiente quedaba "stale" (trabado) en el flujo del conductor.

Ver también: [[00-Contexto]] · [[03-Decisiones]]
