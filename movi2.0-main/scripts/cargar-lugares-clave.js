// ==================================================================
//  Script de carga unica de lugares clave a Supabase (tabla "places").
//  Correr una sola vez a mano: node scripts/cargar-lugares-clave.js
//  No forma parte del build ni de la app en produccion.
// ==================================================================
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { MAPBOX_TOKEN } from '../js/config.js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const RADIO_DEDUP_METROS = 15;
const METROS_POR_GRADO_LAT = 111320;

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

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function existeLugarCercano(lat, lng, radioMetros = RADIO_DEDUP_METROS) {
  const { minLat, maxLat, minLng, maxLng } = calcularBBox(lat, lng, radioMetros);
  const { data, error } = await supabase
    .from('places')
    .select('*')
    .gte('lat', minLat)
    .lte('lat', maxLat)
    .gte('lng', minLng)
    .lte('lng', maxLng);

  if (error) {
    console.error('  Error consultando dedup en Supabase:', error.message);
    return false;
  }
  return data.some((lugar) => distanciaMetros(lat, lng, lugar.lat, lugar.lng) <= radioMetros);
}

// Bbox amplio de Viedma/Patagones para no traer resultados de otras
// provincias (bug conocido: fallback de Mapbox sin bbox se va a nivel
// nacional).
const BBOX_VIEDMA_PATAGONES = '-63.15,-41.10,-62.85,-40.70';

async function geocodificar(direccion) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(direccion)}.json`
    + `?access_token=${MAPBOX_TOKEN}&country=ar&language=es&limit=1&bbox=${BBOX_VIEDMA_PATAGONES}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox respondio ${res.status}`);
  const json = await res.json();
  const feature = json.features?.[0];
  if (!feature) throw new Error('Sin resultados de geocoding');
  const [lng, lat] = feature.center;
  return { lat, lng };
}

async function main() {
  const contenido = await readFile(new URL('../data/lugares-clave.json', import.meta.url), 'utf-8');
  const lugares = JSON.parse(contenido);

  let insertados = 0;
  let salteados = 0;
  let fallidos = 0;

  for (const lugar of lugares) {
    try {
      const { lat, lng } = await geocodificar(lugar.direccion);

      if (await existeLugarCercano(lat, lng)) {
        console.log(`- ${lugar.nombre}: SALTEADO (ya existe uno cerca)`);
        salteados += 1;
        continue;
      }

      const { error } = await supabase.from('places').insert({
        name: lugar.nombre,
        address: lugar.direccion,
        type: lugar.categoria,
        lat,
        lng,
        direccion: lugar.direccion,
        veces_seleccionado: 1,
        verificado: true,
      });

      if (error) throw new Error(error.message);

      console.log(`- ${lugar.nombre}: OK`);
      insertados += 1;
    } catch (err) {
      console.log(`- ${lugar.nombre}: ERROR (${err.message})`);
      fallidos += 1;
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`Insertados: ${insertados}`);
  console.log(`Salteados por duplicado: ${salteados}`);
  console.log(`Fallidos: ${fallidos}`);
}

main();
