# Decisiones de arquitectura / diseño

- El sistema de roles (`rol`: conductor vs pasajero) determina qué UI se muestra. El conductor NO puede tocar el destino del viaje — se bloqueó en `mostrarDestino()` y funciones de edición de paradas, que no tenían chequeo de rol (bug encontrado y corregido).
- La ruta de vista previa para el conductor (viaje pendiente) usa un estilo propio `vista_previa` dentro de `aplicarEstiloRuta`, con color violeta distintivo — para diferenciarla de la ruta activa del viaje.
- El pin de destino en la vista previa es animado (`.destino-pendiente-marker`), reutilizando el patrón de easing ya usado en otros markers/toasts del proyecto.
- Overlays deben mostrarse siempre vía `mostrarOverlay()`, nunca tocando `classList` directamente — para evitar bugs de capas encimadas (ver [[02-Bugs-conocidos]]).
- Config de dev server: puerto reconfigurado en `.claude/launch.json` para evitar CSS stale por procesos previos ocupando el puerto por defecto (5173).
- Cambios de config local / memoria (`.cursor/hooks.json`, `.mcp-memory/memory.json`) se excluyen de los PRs — son locales, no del proyecto.

Ver también: [[00-Contexto]] · [[01-Estado-actual]]
