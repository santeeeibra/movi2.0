# TODO — tareas sueltas entre sesiones

Ideas, pendientes chicos o cosas para probar que van surgiendo. No es la lista
oficial de features grandes (esa está en [[01-Estado-actual]]) — esto es más
para no perder cosas puntuales.

## Sin empezar

- Drawers (menu izquierda / perfil derecha) — hay maqueta HTML aprobada, pedir referencia si hace falta
- Pago + calificación — maqueta aprobada también
- Mapbox Geocoding real (bbox Viedma/Patagones, nunca nacional sin restricción)
- Conectar Supabase (lugares guardados, historial) — instalar como paquete real, no CDN
- Botones de topbar (menu/perfil) — hoy no abren nada
- Precio real para "Normal" y "MOVI Envios" (hoy solo visual)
- Decidir si limpiar/commitear `.cursor/hooks.json` y `.mcp-memory/memory.json` (quedaron modificados sin commitear en varias sesiones)

## Ideas fuertes con n8n (para evaluar)

1. **Movi Concierge por WhatsApp** — AI Agent que recibe "necesito ir de X a Y",
   geocodifica con Mapbox (bbox VDM/PAT), estima precio, y crea el viaje en la
   misma tabla `viajes` de Supabase que usa la PWA. Cero instalación para el
   pasajero, cero cambio para el conductor. HITL antes de confirmar el viaje.
2. **Dispatch inteligente a conductores por Telegram** — si un viaje queda sin
   taker >30s, un agente elige el conductor más apto (cercanía + tasa de
   aceptación histórica) y le manda botones Aceptar/Rechazar.
3. **Reporte semanal automático** al admin en Telegram: viajes, ingresos, top
   orígenes/destinos, direcciones fallidas de geocoding, conductores activos.
   Cron lunes 9am, consulta a Supabase.
4. **Soporte al pasajero por WhatsApp** con el mismo número del concierge:
   Text Classifier n8n → cancelación / queja / duda de precio / pérdida de
   objeto → cada rama con su tool o escalación a admin.
5. **Onboarding de conductores por WhatsApp**: al insertarse un conductor
   pendiente, workflow le pide foto de licencia + cédula + seguro paso a paso,
   valida con Vision del modelo, y notifica al admin cuando está completo.
6. **Detector de direcciones huérfanas**: cada vez que Mapbox no encuentra una
   dirección pedida, se loguea a Supabase; workflow semanal las clusteriza y
   te sugiere POIs locales para agregar como "lugares conocidos de Viedma".

## Ideas de automatización (n8n) — brainstorm original

Una vez que Supabase esté conectado, hay bastante lugar para mover lógica de
notificaciones/orquestación fuera de la app a workflows de n8n en vez de
hardcodear todo en `app.js`:

- Notificar por WhatsApp/SMS al pasajero cuando el conductor acepta el viaje
  (trigger: insert/update en tabla `viajes` de Supabase vía webhook → n8n → API de WhatsApp/Twilio)
- Alertar a un canal (Telegram/Slack) cuando un viaje queda "buscando conductor"
  más de X segundos sin nadie que lo tome, para intervención manual
- Automatizar onboarding de conductores nuevos: al insertar un conductor pendiente
  de aprobación, disparar workflow que arme un checklist y notifique al admin
- Resumen diario/semanal de viajes (cantidad, ingresos estimados, zonas más pedidas)
  armado con un cron en n8n que consulta Supabase y manda un mensaje/email
- Reintentos automáticos de geocoding fallido (cuando Mapbox no encuentra resultados
  en el bbox de Viedma/Patagones) con logging a una tabla para revisar direcciones raras
- Sincronizar calificaciones bajas con una alerta automática para revisión

## En progreso

-

## Hecho

-

Ver también: [[00-Contexto]] · [[01-Estado-actual]]
