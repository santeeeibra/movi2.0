# Movi — Contexto del proyecto

App de viajes tipo Uber/Cabify para Viedma/Patagones. Mobile-first: se prueba
principalmente instalada como PWA en celular, no en escritorio.

## Stack

- Vite (dev server + build) + JavaScript vanilla con ES Modules.
- Mapbox GL JS para el mapa (cargado por `<script>` externo en index.html).
- Supabase para datos — TODAVIA NO conectado (ver [[01-Estado-actual]]).

## Identidad visual (ya definida, no rediseñar)

- Colores: negro (`--negro: #14171A`) y verde (`--verde: #1F8A4C`), fondo crema (`--crema: #F7F6F2`).
- Fuente: Nunito (no Poppins).
- Estilo "Liquid Glass": `backdrop-filter: blur()` + fondos semitransparentes + borde fino de luz.
- Sistema de capas (z-index) centralizado en `:root` de `css/styles.css` — nunca hardcodear un z-index nuevo.

## Cómo correrlo local

```
npm install
npm run dev
```

## Regla de oro

Un cambio chico por vez, probado en el celular antes de seguir. Después de cada cambio:

```
npx eslint .
npx vite build
```

Ambos tienen que salir limpios (0 errores) antes de dar algo por terminado.

Ver también: [[01-Estado-actual]] · [[02-Bugs-conocidos]] · [[03-Decisiones]] · [[04-Convenciones]] · [[05-TODO]]
