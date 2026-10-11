-- Solo lectura: ejecutar en el proyecto lapnbdpdkkeaaavvkfqc antes del cambio.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('conductores', 'viajes')
order by table_name, ordinal_position;

select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('conductores', 'viajes');

select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in ('conductores', 'viajes');

select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers
where event_object_schema = 'public' and event_object_table in ('conductores', 'viajes');
