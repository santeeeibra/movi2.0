-- Propuesta de esquema para revisar DESPUES del preflight.
-- No se ha ejecutado en el proyecto real. El preflight se reviso el
-- 2026-10-11 con santi MOVI: existen politicas publicas y un webhook n8n.
-- Coordinar con SMTP, perfiles verificados y despliegue del nuevo cliente;
-- aplicar estas restricciones antes bloquearia al cliente publicado.
-- Los perfiles anteriores conservan auth_user_id NULL: solo el propietario
-- debe vincularlos a un usuario cuyo correo ya este verificado.
begin;

alter table public.conductores
  add column if not exists auth_user_id uuid references auth.users(id);
create unique index if not exists conductores_auth_user_id_key
  on public.conductores (auth_user_id);
alter table public.conductores enable row level security;

-- Las reglas restrictivas se combinan con las anteriores mediante AND:
-- una politica permisiva antigua no debe permitir escrituras anonimas.
drop policy if exists movi_driver_insert_guard on public.conductores;
create policy movi_driver_insert_guard on public.conductores
  as restrictive for insert to anon, authenticated
  with check (auth_user_id = (select auth.uid()));
drop policy if exists movi_driver_update_guard on public.conductores;
create policy movi_driver_update_guard on public.conductores
  as restrictive for update to anon, authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));
drop policy if exists movi_driver_delete_guard on public.conductores;
create policy movi_driver_delete_guard on public.conductores
  as restrictive for delete to anon, authenticated
  using (auth_user_id = (select auth.uid()));

drop policy if exists movi_driver_select_own on public.conductores;
create policy movi_driver_select_own on public.conductores
  for select to authenticated using (auth_user_id = (select auth.uid()));
drop policy if exists movi_driver_insert_own on public.conductores;
create policy movi_driver_insert_own on public.conductores
  for insert to authenticated with check (auth_user_id = (select auth.uid()));
drop policy if exists movi_driver_update_own on public.conductores;
create policy movi_driver_update_own on public.conductores
  for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));
grant select, insert, update on public.conductores to authenticated;

-- El servidor tambien debe validar quien acepta o cambia el estado.
-- No usa SECURITY DEFINER ni confia en rol/es_admin del navegador.
create or replace function public.movi_guard_driver_trip()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  driver_phone text;
  actor_id uuid := auth.uid();
  driver_action boolean;
begin
  driver_action := new.conductor_telefono is distinct from old.conductor_telefono
    or (new.estado is distinct from old.estado and new.estado in ('conductor_asignado', 'llegó', 'en_viaje', 'finalizado'))
    or (new.estado = 'cancelado' and new.estado is distinct from old.estado and actor_id is not null)
    or new.nombre_conductor is distinct from old.nombre_conductor
    or new.patente_conductor is distinct from old.patente_conductor
    or new.modelo_auto_conductor is distinct from old.modelo_auto_conductor
    or new.color_auto_conductor is distinct from old.color_auto_conductor
    or new.eta_minutos is distinct from old.eta_minutos;
  if driver_action then
    driver_phone := coalesce(old.conductor_telefono, new.conductor_telefono);
    if actor_id is null or not exists (
      select 1 from public.conductores c
      where c.telefono = driver_phone and c.auth_user_id = actor_id
    ) then
      raise exception 'Solo el conductor autenticado puede realizar esta accion' using errcode = '42501';
    end if;
    if new.estado = 'cancelado' then
      if old.estado not in ('conductor_asignado', 'llegó') then
        raise exception 'Solo puede cancelarse una recogida pendiente' using errcode = '23514';
      end if;
      new.tarifa_cancelacion := 0;
    end if;
  end if;

  if new.conductor_telefono is distinct from old.conductor_telefono then
    if old.conductor_telefono is not null or old.estado <> 'pendiente'
      or new.conductor_telefono is null or new.estado <> 'conductor_asignado' then
      raise exception 'Este viaje ya no puede asignarse' using errcode = '23514';
    end if;
    -- Serializar aceptaciones del mismo chofer, incluso desde dos celulares.
    perform pg_advisory_xact_lock(hashtextextended(new.conductor_telefono, 0));
    if exists (
      select 1 from public.viajes v where v.id <> old.id
        and v.conductor_telefono = new.conductor_telefono
        and v.estado in ('conductor_asignado', 'llegó', 'en_viaje')
    ) then
      raise exception 'El conductor ya tiene un viaje activo' using errcode = '23514';
    end if;
  end if;

  if new.estado is distinct from old.estado then
    if new.estado = 'llegó' and old.estado <> 'conductor_asignado'
      or new.estado = 'en_viaje' and old.estado <> 'llegó'
      or new.estado = 'finalizado' and old.estado <> 'en_viaje' then
      raise exception 'Transicion de viaje invalida' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.movi_guard_driver_trip() from public;
drop trigger if exists movi_guard_driver_trip on public.viajes;
create trigger movi_guard_driver_trip before update on public.viajes
  for each row execute function public.movi_guard_driver_trip();

commit;
