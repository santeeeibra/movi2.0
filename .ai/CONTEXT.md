# 🚗 MOVI — Contexto Compartido para IAs
> Este archivo es el "cerebro" del proyecto. Toda IA que trabaje en Movi debe leerlo al inicio.
> Actualizar después de cada cambio importante.

---

## ¿Qué es Movi?
App de remises (tipo Uber/Cabify) para las ciudades de **Viedma y Carmen de Patagones**, Argentina.
Resuelve un problema real: los taxis locales son caros, el sistema es llamada por teléfono o WhatsApp, sin tracking ni precio claro.
Movi ofrece: pedido desde celular, precio transparente antes de confirmar, y tracking del conductor en tiempo real.

**Estrategia de lanzamiento:** arrancar con 2-3 remiseros independientes → crecer por demanda → los taxis establecidos se suman solos.

---

## Stack Técnico

| Capa | Tecnología | Notas |
|---|---|---|
| Frontend | HTML + CSS + JS Vanilla (ES Modules) | **Sin frameworks. Sin build step.** |
| Base de datos | Supabase (PostgreSQL) | Realtime activado más adelante para tracking de conductor |
| Mapas | Mapbox GL JS | Estilo "streets" a color, sin terreno/relieve |
| Deploy | Vercel | Auto-deploy desde `main` en GitHub |
| PWA | Sí | Se instala desde Safari en iPhone |

**⚠️ Regla crítica: NO agregar React, Vue, Vite, Webpack ni ningún build step. El proyecto corre directo en el browser.**

---

## Repositorio y Deploy

- **GitHub:** https://github.com/santeeeibra/movi2.0 (usuario: `santeeeibra`, rama: `main`)
- **Vercel:** https://movi2-0.vercel.app/ — cada push a `main` redespliega automáticamente
- **Carpeta local (Windows):** `C:\Users\hermo\Downloads\MOVI-actualizado`

---

## Identidad Visual

- **Color de marca:** VERDE — es el color principal, no reemplazarlo, solo refinar su uso
- **UX:** Mobile-first siempre. Se prueba en iPhone (Safari → "Agregar a pantalla de inicio")

---

## Tarifas

| Concepto | Valor |
|---|---|
| Mínimo | $2.000 |
| Por kilómetro | $200/km |
| Por minuto | $80/min |

---

## Funcionalidades Implementadas

### Mapa
- Estilo Mapbox "streets" a color
- **Pin de origen:** ubicación real del usuario, arrastrable (para pedir para otra persona)
- **Pin de destino:** visible al elegir resultado de búsqueda
- **Auto 3D del conductor:** 4 capas Mapbox `type: 'model'` (auto-paint con color dinámico, auto-trim, auto-lights, auto-wheels) alimentadas por fuente GeoJSON `auto-conductor`

### Lugares / Destinos (sistema híbrido)
- **Lugares verificados:** ~73 lugares clave de Viedma y Patagones cargados manualmente (`verificado = true`), aparecen desde el día 1
- **Aprendizaje automático:** cuando un usuario elige un POI con nombre (vía Mapbox Reverse Geocoding), se suma 1 a `veces_seleccionado`; un lugar no verificado aparece para otros usuarios al llegar a 3 selecciones
- **Tabla en Supabase:** `places` con columnas `veces_seleccionado` (integer, default 1) y `verificado` (boolean, default false). Cuenta con columna geográfica `coords` (tipo `geography`), un índice espacial GIST y búsqueda optimizada por radio de distancia vía RPC `get_places_in_radius` (con fallback de BBox seguro en el frontend).
- Categorías cubiertas: salud, educación, hoteles, bancos, supermercados, farmacias, estaciones de servicio, organismos públicos, seguridad, justicia, cultura, gimnasios, recreación, turismo, transporte

---

## Bugs Pendientes (prioridad)

- [ ] Panel dev roto
- [ ] Botones sin funcionalidad (varios)
- [ ] Menú de perfil sin implementar
- [ ] Configuración sin implementar
- [ ] Ayuda/soporte sin implementar

---

## Estructura de Archivos Clave

```
movi2.0/
├── index.html          ← Entry point de la app
├── app.js              ← Lógica principal
├── map.js              ← Todo lo de Mapbox
├── supabase.js         ← Cliente Supabase y queries
├── styles/             ← CSS
├── .ai/
│   ├── CONTEXT.md      ← Este archivo (cerebro compartido)
│   ├── TASKS.md        ← Tareas en progreso y pendientes
│   ├── DECISIONS.md    ← Decisiones de arquitectura tomadas
│   └── STACK.md        ← Variables de entorno y configuración
└── .cursorrules        ← Reglas automáticas para Cursor/Codex
```

---

## Variables de Entorno (no hardcodear en código)

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
MAPBOX_TOKEN=...
```
Están en `.env` local y en las variables de entorno de Vercel.

---

## Convenciones de Código

- Comentarios en **español**
- Nombres de variables en **camelCase** en inglés
- Funciones async/await, no callbacks anidados
- Un archivo por responsabilidad (no meter todo en `app.js`)
- Antes de agregar una librería externa, preguntar si realmente es necesaria

---

## Historial de Decisiones Importantes

| Decisión | Motivo |
|---|---|
| Vanilla JS sin framework | Simplicidad, sin build step, deploya directo |
| Supabase sobre Firebase | SQL real, más control, free tier generoso |
| Mapbox sobre Google Maps | Mejor soporte para capas 3D tipo `model`, más customizable |
| PWA sobre app nativa | Sin tiendas, instalación directa desde Safari/Chrome |
| Tarifas en frontend | Cálculo simple, sin lógica de backend para el MVP |

---

## Contexto para la IA que lee esto

Estás trabajando en un proyecto real, en producción, con usuarios reales pronto.
El developer es autodidacta, trabaja solo, usa Windows + PowerShell + Cursor + Cline.
Las respuestas deben ser **concretas, aplicables directamente al código existente**.
No sugerir cambios de stack ni arquitecturas nuevas sin necesidad urgente.
Siempre verificar que los cambios no rompan el deploy automático en Vercel.
