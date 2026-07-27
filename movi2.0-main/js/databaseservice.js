// ==================================================================
//  Conexion a Supabase. Cliente unico, exportado para el resto de la app.
// ==================================================================
import { createClient } from '@supabase/supabase-js';
import { MAPBOX_TOKEN } from './config.js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const METROS_POR_GRADO_LAT = 111320;

// Bounding box aproximado a partir de un centro y un radio en metros.
// Alcanza para filtrar en Supabase (no tenemos PostGIS habilitado); la
// distancia real se recalcula despues con distanciaMetros() donde importe.
function calcularBBox(lat, lng, radioMetros) {
  const metrosPorGradoLng = METROS_POR_GRADO_LAT * Math.cos((lat * Math.PI) / 180);
  const deltaLat = radioMetros / METROS_POR_GRADO_LAT;
  const deltaLng = radioMetros / metrosPorGradoLng;
  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLng: lng - deltaLng,
    maxLng: lng + deltaLng,
  };
}

export function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// zona (opcional): { lat, lng, radioMetros }. Si no se pasa, trae todo
// (evitar en pantallas normales — es el caso que gasta banda ancha de mas).
export async function getLugares(zona) {
  let query = supabase.from('places').select('*');

  if (zona) {
    const { minLat, maxLat, minLng, maxLng } = calcularBBox(zona.lat, zona.lng, zona.radioMetros);
    query = query.gte('lat', minLat).lte('lat', maxLat).gte('lng', minLng).lte('lng', maxLng);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[Movi] Error trayendo lugares de Supabase:', error);
    return [];
  }
  return data;
}

// Deduplicacion por cercania real (no por texto): true si ya hay un lugar
// guardado a menos de radioMetros del punto dado.
export async function existeLugarCercano(lat, lng, radioMetros = 15) {
  const cercanos = await getLugares({ lat, lng, radioMetros });
  return cercanos.some((lugar) => distanciaMetros(lat, lng, lugar.lat, lugar.lng) <= radioMetros);
}

// Postgres ILIKE es sensible a tildes (no hay unaccent habilitado), y en
// el celular casi nadie las escribe: "la anonima" no matchea "La Anónima".
// Se usa para normalizar el fallback de abajo.
function normalizarTexto(texto) {
  return (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Lugares guardados en Supabase cuyo nombre contiene el texto buscado
// (comercios locales que Mapbox no tiene bien indexados para esta zona).
export async function searchLugares(query) {
  const texto = (query || '').trim();
  if (!texto) return [];

  // Un lugar recien aprendido (un solo click) no debe contaminar los
  // resultados de otros usuarios hasta que este verificado a mano o lo
  // haya elegido gente distinta varias veces.
  const { data, error } = await supabase
    .from('places')
    .select('*')
    .ilike('name', `%${texto}%`)
    .or('verificado.eq.true,veces_seleccionado.gte.3')
    .limit(5);

  if (error) {
    console.error('[Movi] Error buscando lugares en Supabase:', error);
    return [];
  }
  if (data.length > 0) return data;

  // Sin resultados con ILIKE directo: puede ser un problema de tildes.
  // Traemos candidatos y comparamos sin tildes del lado del cliente.
  const { data: todos, error: errorTodos } = await supabase
    .from('places')
    .select('*')
    .or('verificado.eq.true,veces_seleccionado.gte.3')
    .limit(1000);

  if (errorTodos) {
    console.error('[Movi] Error en fallback de busqueda sin tildes:', errorTodos);
    return [];
  }

  const textoNormalizado = normalizarTexto(texto);
  return todos
    .filter((l) => normalizarTexto(l.name).includes(textoNormalizado))
    .slice(0, 5);
}

export async function reverseGeocode(lat, lng) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_TOKEN}&language=es&limit=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json.features?.[0]?.place_name ?? null;
  } catch (err) {
    console.error('[Movi] Error en reverse geocoding de Mapbox:', err);
    return null;
  }
}

// Reverse geocoding restringido a POIs (comercios/lugares con nombre
// propio, no direcciones peladas). Devuelve null si el punto tocado no
// cae sobre un negocio/lugar con nombre real — ahi no hay nada que
// aprender (mitad de una cuadra, terreno baldio, etc.).
async function reverseGeocodePOI(lat, lng) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`
    + `?access_token=${MAPBOX_TOKEN}&language=es&types=poi&limit=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const feature = json.features?.[0];
    if (!feature?.place_type?.includes('poi') || !feature.text) return null;
    return { name: feature.text, address: feature.place_name };
  } catch (err) {
    console.error('[Movi] Error en reverse geocoding de POI de Mapbox:', err);
    return null;
  }
}

// Aprendizaje automatico de lugares: se llama cada vez que se confirma un
// destino (resultado de busqueda o toque directo en el mapa). Solo actua
// si el punto es un POI con nombre real segun Mapbox — una direccion
// pelada no suma nada util a "places". Si ya hay un lugar guardado cerca
// (<=radioDedupMetros), suma un voto (veces_seleccionado); si no, lo crea
// sin verificar todavia.
export async function registrarSeleccionDeLugar(lat, lng, radioDedupMetros = 15) {
  const poi = await reverseGeocodePOI(lat, lng);
  if (!poi) return null;

  const cercanos = await getLugares({ lat, lng, radioMetros: radioDedupMetros });
  const existente = cercanos.find((l) => distanciaMetros(lat, lng, l.lat, l.lng) <= radioDedupMetros);

  if (existente) {
    const { data, error } = await supabase
      .from('places')
      .update({ veces_seleccionado: (existente.veces_seleccionado || 0) + 1 })
      .eq('id', existente.id)
      .select()
      .single();
    if (error) {
      console.error('[Movi] Error sumando veces_seleccionado en Supabase:', error);
      return null;
    }
    return data;
  }

  const { data, error } = await supabase
    .from('places')
    .insert({
      name: poi.name,
      address: poi.address,
      type: null,
      lat,
      lng,
      direccion: poi.name,
      veces_seleccionado: 1,
      verificado: false,
    })
    .select()
    .single();
  if (error) {
    console.error('[Movi] Error guardando lugar nuevo en Supabase:', error);
    return null;
  }
  return data;
}
