# Notas — Flujo del conductor (rama feature/conductor-flow)

## Contexto importante antes de leer esto

Esta rama arranca **sobre el `main` real** que ya incluía el auto animado
siguiendo la ruta (icono symbol de Mapbox, tracking GPS del conductor), que
se había armado en una sesión previa con Cursor. No se reescribió nada de
eso — solo se corrigió un bug puntual (ver más abajo) y se construyó el
flujo del conductor encima.

## Fix aplicado (pedido explícito): el auto no se pegaba a la calle

**Causa:** `aplicarNuevaPosicionConductor()` movía el ícono directo a las
coordenadas crudas del GPS del conductor, sin relación con la ruta
dibujada, y sin animación (saltaba de golpe en cada actualización).

**Solución:** se agregó `proyectarEnRuta()`, que toma el fix crudo del GPS
y lo proyecta sobre el segmento más cercano de `rutaGeometriaActual` (la
geometría de la última ruta calculada con `getRuta`). Si el conductor se
desvía más de 60m de la ruta calculada, se usa el punto crudo tal cual (para
no "pegarlo" a una calle que ya no está siguiendo). Se agregó también
`animarAutoHacia()`, que interpola suavemente (2.2s) entre la posición
anterior y la nueva, tanto en lat/lng como en el ángulo de rotación
(por el camino más corto, para que nunca "dé la vuelta larga").

`rutaGeometriaActual` se actualiza en `recalcularRuta()` (lado pasajero) y
en las dos funciones nuevas de ruta del lado conductor (ver Fase 4).

## Fases completadas

- **Fase 0** — Botón "Atrás" en login de pasajero y registro de conductor,
  vuelve a `role-select-overlay` sin tocar localStorage.
- **Fase 1** — Toggle "Disponible / No disponible" en la pantalla del
  conductor, sincronizado con la columna `disponible` de Supabase. Se lee
  el valor real al cargar la página (no asume `false` por defecto), para
  que un refresh de página no te saque de "disponible" sin querer.
- **Fase 2** — Lista de viajes pendientes en tiempo real (Realtime +
  refetch completo ante cualquier cambio en `estado='pendiente'` — no se
  intentó hacer merge incremental para no complicar, con el volumen de
  viajes esperado por ahora no debería notarse).
- **Fase 3** — Aceptar viaje con `UPDATE ... WHERE conductor_telefono IS
  NULL`, así que si dos conductores tocan "Aceptar" casi al mismo tiempo,
  solo uno gana (el otro ve "Ya fue tomado" y la lista se refresca sola).
  `buscarConductorDisponible()` y `datosConductorParaViaje()` **no se
  borraron** — las sigue usando el panel de desarrollador para sus
  simulaciones, pero el flujo real de "Pedir viaje" ya no las llama.
- **Fase 4** — Vista de viaje activo del conductor con Llegué / Iniciar
  viaje / Finalizar. La ruta hacia el origen se dibuja una vez al entrar
  a la vista (con `getCurrentPosition`, no watch continuo — no hace falta
  redibujar la ruta constantemente, la posición del auto ya se anima con
  el icono en tiempo real). Al iniciar el viaje, se recalcula la ruta
  completa pasando por todas las paradas guardadas.
- **Fase 5** — Al finalizar o cancelar, vuelve solo a la lista de
  pendientes y pone `disponible = true` de nuevo.
- **Fase 6** — Historial de viajes (pasajero: por `telefono_pasajero`;
  conductor: por `conductor_telefono`), estados `finalizado`/`cancelado`.

## Decisiones que tomé sin especificación exacta

1. **El flujo real de "Pedir viaje" ya no auto-asigna un conductor.** Antes
   simulaba 2 segundos de "buscando" y le asignaba un conductor al azar
   (`buscarConductorDisponible`). Ahora el viaje queda en `pendiente` de
   verdad y se suscribe por Realtime a ese viaje puntual hasta que un
   conductor real lo acepte. Si el pasajero cancela la búsqueda, el viaje
   pasa a `cancelado` (antes quedaba huérfano en `pendiente` para siempre,
   lo cual ahora rompería la lista de los conductores).

2. **Fix adicional no pedido explícitamente, pero necesario:** el insert
   real de "Pedir viaje" nunca guardaba `origen_lat` / `origen_lng` /
   `origen_direccion` (solo lo hacía la simulación del panel de dev). Sin
   esto, ni la lista de pendientes ni la ruta del conductor hacia el
   origen tenían de dónde sacar esos datos. Se agregó `reverseGeocode()`
   sobre `origenActual` al crear el viaje.

3. **`driver-sheet` (la ficha "conductor asignado" del lado pasajero)
   estaba con datos de ejemplo hardcodeados** ("Leyvan Esquercia", "Toyota
   Corolla") y nunca se actualizaba con el conductor real. Se agregó
   `aplicarDatosConductorEnSheet()` para llenarla con los datos reales
   apenas un conductor acepta.

4. **Se ocultó explícitamente `#sheet` (la ficha de búsqueda del
   pasajero)** al entrar a la vista de viaje activo del conductor, y se
   restaura al volver a disponible o cerrar sesión. `driver-active-sheet`
   no es un overlay de pantalla completa (es una ficha inferior, como
   `driver-sheet`), así que sin este fix el mapa y la ficha de búsqueda
   quedaban visibles de fondo en la sesión del conductor.

5. **La lista de pendientes no filtra por cercanía geográfica** — muestra
   todos los viajes pendientes de la ciudad, ordenados por más reciente.
   Queda marcado con un comentario `TODO` en el código.

## Verificación hecha antes de entregar esto

- `node --check js/app.js` sin errores de sintaxis.
- `npx vite build` completo sin errores (380 módulos).
- Verificación cruzada automática: todos los `getElementById(...)` del
  JS tienen su `id` correspondiente en el HTML (sin ids huérfanos).

**Lo que NO se probó:** no hay forma de correr un navegador real con GPS,
Supabase y Mapbox en este entorno, así que el flujo no se probó de punta a
punta de forma interactiva. La verificación fue estática (sintaxis, build,
referencias cruzadas) y por lectura cuidadosa de cada función. Conviene
probarlo en el navegador real antes de mergear a `main`, con al menos dos
dispositivos (uno como pasajero, otro como conductor) para el camino
completo: pedir viaje → aceptar → llegué → iniciar → finalizar →
historial.

## Dudas / pendientes para revisar juntos

- ¿El precio del viaje pendiente que ve el conductor (`v.precio`) alcanza
  como información, o convendría mostrar también la distancia/duración
  estimada en la tarjeta de la lista?
- Hoy cualquier conductor disponible ve **todos** los viajes pendientes de
  toda la ciudad. Cuando haya más de un conductor real usando la app en
  simultáneo, probablemente convenga filtrar por radio de cercanía (queda
  anotado como mejora futura en el código).
- No se tocó el botón `btn-centrar-mapa` para adaptarlo a la perspectiva
  del conductor (hoy solo razona desde el punto de vista del pasajero,
  `viajeActivoPasajero`). Si se quiere que el conductor también tenga un
  botón para centrar el mapa en su propia posición o en el origen del
  pasajero, es un ajuste aparte.
