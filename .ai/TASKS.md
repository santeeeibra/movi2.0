# Tareas Movi
> Actualizar este archivo al terminar cada sesión de trabajo.

---

## 🔴 En progreso
- [ ] Auto 3D del conductor (4 capas Mapbox type:model) — en local, pendiente push a main

## 🟡 Pendientes (bugs)
- [ ] Arreglar panel dev (roto)
- [ ] Implementar botones sin funcionalidad
- [ ] Implementar menú de perfil
- [ ] Implementar pantalla de configuración
- [ ] Implementar pantalla de ayuda/soporte

## 🟡 Pendientes (features)
- [ ] Activar Supabase Realtime para tracking de conductor en vivo
- [ ] Panel del conductor (app separada o modo conductor en la misma app)
- [ ] Sistema de pagos / registro de viajes

## ✅ Completadas
- [x] Optimización geográfica con PostGIS (índice espacial GIST + función RPC `get_places_in_radius` con fallback BBox seguro de cliente en frontend)
- [x] 73 lugares verificados cargados en Supabase (verificado=true)
- [x] Sistema híbrido de lugares: verificados manuales + aprendizaje por clicks
- [x] Tarifas definidas: $2.000 mín + $200/km + $80/min
- [x] Pin de origen en ubicación real del usuario (arrastrable)
- [x] Pin de destino visible al elegir resultado de búsqueda
- [x] Mapa con estilo streets a color (sin relieve/terreno)
- [x] Deploy en Vercel conectado a GitHub (auto-deploy)
- [x] App instalable como PWA en iPhone
