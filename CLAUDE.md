# Movi — Contexto del proyecto (reinicio limpio)

App de viajes tipo Uber/Cabify para Viedma/Patagones. Mobile-first: se prueba
principalmente instalada como PWA en celular, no en escritorio.

## Stack

- Vite (dev server + build) + JavaScript vanilla con ES Modules.
- Mapbox GL JS para el mapa (cargado por `<script>` externo en index.html).
- Supabase para datos — TODAVIA NO conectado en este reinicio (ver "Estado
  actual" abajo). Cuando se conecte, instalar como paquete real
  (`npm install @supabase/supabase-js`), no por CDN.

## Identidad visual (ya definida, no rediseñar)

- Colores: negro (`--negro: #14171A`) y verde (`--verde: #1F8A4C`) como
  identidad principal, sobre fondo crema (`--crema: #F7F6F2`).
- Fuente: Nunito (redondeada, amigable) — no Poppins.
- Estilo "Liquid Glass" (vidrio esmerilado): `backdrop-filter: blur()` +
  fondos semitransparentes + borde fino de luz, en topbar, sheets, chips.
- Sistema de capas (z-index) centralizado en `:root` de `css/styles.css` —
  nunca hardcodear un z-index nuevo, agregar la variable primero.

## Cómo correrlo local

```
npm install
npm run dev
```

## Antes de cada cambio — regla de oro

**Un cambio chico por vez, probado en el celular antes de seguir.** Este
proyecto se reinició una vez ya por hacer ediciones grandes de golpe sin
verificar — no repetir ese error. Después de cada cambio:

```
npx eslint .
npx vite build
```

Ambos tienen que salir limpios (0 errores) antes de dar algo por terminado.

## Estado actual (que pantallas ya estan en codigo real)

1. ✅ Mapa + topbar (menu/perfil, todavia sin funcion) — `index.html`, `css/styles.css`, `js/app.js`
2. ✅ Buscador con resultados de ejemplo (3 resultados hardcodeados, NO conectado a Mapbox Geocoding real todavia) + chips de guardados (Casa/Trabajo/Otros, sin funcion real todavia)
3. ✅ Flujo Pedir viaje -> Buscando conductor (2s simulado) -> Conductor asignado (datos de ejemplo hardcodeados)
4. ✅ Arrastrar los sheets hacia abajo/arriba para colapsar/expandir (funcion `hacerArrastrable()` en app.js, generica para `#sheet` y `#driver-sheet`)
5. ⬜ Drawers (menu izquierda / perfil derecha) — PENDIENTE, hay una maqueta HTML aprobada del diseño (preguntame por ella si hace falta referencia)
6. ⬜ Pago + calificacion — PENDIENTE, maqueta aprobada tambien

## Lo que falta conectar de verdad (todo con datos de ejemplo por ahora)

- Mapbox Geocoding real (buscar direcciones de verdad, con bbox de
  Viedma/Patagones, nunca nacional sin restriccion)
- Supabase (lugares guardados, historial, etc.)
- Los botones de topbar (menu/perfil) no abren nada todavia
- Los tipos de viaje "Normal" y "MOVI Envios" son visuales, sin logica de
  precio real conectada

## Bugs conocidos de la version anterior (para NO repetir)

1. `mousedown` en vez de `pointerdown`/`click` en elementos tactiles.
2. z-index hardcodeado o inyectado por JS (`style.zIndex = '99999'`) en vez
   de las variables de `:root`.
3. Imports que faltan silenciosamente — un modulo bien escrito pero nunca
   importado no tira error, simplemente no hace nada.
4. `document.addEventListener('DOMContentLoaded', ...)` puede registrarse
   DESPUES de que el evento ya disparo (con modulos ES, el orden no esta
   garantizado) — usar el patron: chequear `document.readyState` primero.
5. Búsqueda de Mapbox sin bbox en el fallback trae resultados de otras
   provincias — el fallback debe ampliar la zona, nunca ir a nivel nacional.

## Convenciones

- Comentarios y textos de UI en español (Argentina), sin tildes en el
  código/comentarios si el editor no maneja bien UTF-8 (paso ya causo
  corrupcion de caracteres antes).
