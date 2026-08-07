-- ==================================================================
--  Movi - Optimización Geográfica con PostGIS
--  Instrucciones: Ejecutar este script en el editor SQL de Supabase.
-- ==================================================================

-- 1. Habilitar la extensión PostGIS en la base de datos
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Crear la columna de coordenadas espaciales tipo 'geography'
ALTER TABLE places ADD COLUMN IF NOT EXISTS coords geography(Point, 4326);

-- 3. Función del trigger para sincronizar lat/lng con coords automáticamente
CREATE OR REPLACE FUNCTION update_places_coords()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
    NEW.coords := ST_SetSRID(ST_Point(NEW.lng, NEW.lat), 4326)::geography;
  ELSE
    NEW.coords := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Crear el trigger para que cualquier INSERT o UPDATE mantenga coords sincronizada
DROP TRIGGER IF EXISTS trg_update_places_coords ON places;
CREATE TRIGGER trg_update_places_coords
BEFORE INSERT OR UPDATE OF lat, lng ON places
FOR EACH ROW
EXECUTE FUNCTION update_places_coords();

-- 5. Backfill (actualizar datos existentes)
UPDATE places 
SET coords = ST_SetSRID(ST_Point(lng, lat), 4326)::geography 
WHERE lat IS NOT NULL AND lng IS NOT NULL AND coords IS NULL;

-- 6. Crear un índice espacial GIST sobre la columna coords
CREATE INDEX IF NOT EXISTS places_coords_gist ON places USING GIST(coords);

-- 7. Función RPC para realizar búsquedas por radio ordenadas por distancia
CREATE OR REPLACE FUNCTION get_places_in_radius(px_lat float8, px_lng float8, px_radio_metros float8)
RETURNS SETOF places AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM places
  WHERE ST_DWithin(
    coords,
    ST_SetSRID(ST_Point(px_lng, px_lat), 4326)::geography,
    px_radio_metros
  )
  ORDER BY coords <-> ST_SetSRID(ST_Point(px_lng, px_lat), 4326)::geography;
END;
$$ LANGUAGE plpgsql;
