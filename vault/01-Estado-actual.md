# Estado actual — pantallas y features

## Listo (código real)

1. ✅ Mapa + topbar (menu/perfil, todavia sin funcion) — `index.html`, `css/styles.css`, `js/app.js`
2. ✅ Buscador con resultados de ejemplo (3 hardcodeados, NO conectado a Mapbox Geocoding real) + chips de guardados (Casa/Trabajo/Otros, sin funcion real)
3. ✅ Flujo Pedir viaje -> Buscando conductor (2s simulado) -> Conductor asignado (datos de ejemplo)
4. ✅ Arrastrar sheets hacia abajo/arriba (`hacerArrastrable()` en app.js, generica para `#sheet` y `#driver-sheet`)
5. ✅ Vista previa de ruta del viaje pendiente para el conductor, con pin animado de destino y color violeta propio (`aplicarEstiloRuta`, estilo `vista_previa`)
6. ✅ Modelo 3D del auto del conductor, fijo al nivel del piso, cámara en pitch (`agregarModeloAuto3D`, `enfocarCamaraConductor`)
7. ✅ Bloqueo de rol: el conductor no puede seleccionar/modificar el destino del viaje (solo el pasajero)

## Pendiente

- ⬜ Drawers (menu izquierda / perfil derecha) — hay maqueta HTML aprobada (pedir referencia si hace falta)
- ⬜ Pago + calificación — maqueta aprobada también
- ⬜ Mapbox Geocoding real (con bbox de Viedma/Patagones, nunca nacional sin restricción)
- ⬜ Supabase (lugares guardados, historial, etc.) — instalar como paquete real, no CDN
- ⬜ Botones de topbar (menu/perfil) sin abrir nada
- ⬜ Precio real para "Normal" y "MOVI Envios" (hoy solo visual)

Ver también: [[00-Contexto]] · [[02-Bugs-conocidos]] · [[03-Decisiones]]
