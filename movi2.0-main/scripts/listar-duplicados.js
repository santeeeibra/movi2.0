// ==================================================================
//  Script de SOLO LECTURA: lista los lugares del JSON que matchean
//  como "cercanos" a algo ya cargado en Supabase, junto con el
//  lugar existente detectado. No inserta ni modifica nada.
//  Correr a mano: node scripts/listar-duplicados.js
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

async function buscarLugarCercano(lat, lng, radioMetros = RADIO_DEDUP_METROS) {
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
    return null;
  }
  return data.find((lugar) => distanciaMetros(lat, lng, lugar.lat, lugar.lng) <= radioMetros) || null;
}

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

  const duplicados = [];

  for (const lugar of lugares) {
    try {
      const { lat, lng } = await geocodificar(lugar.direccion);
      const existente = await buscarLugarCercano(lat, lng);

      if (existente) {
        duplicados.push({ nuevo: lugar, existente });
        console.log(`- ${lugar.nombre}: DUPLICADO`);
      } else {
        console.log(`- ${lugar.nombre}: sin match`);
      }
    } catch (err) {
      console.log(`- ${lugar.nombre}: ERROR (${err.message})`);
    }
  }

  console.log(`\n--- ${duplicados.length} duplicados detectados ---\n`);
  duplicados.forEach(({ nuevo, existente }, i) => {
    console.log(`${i + 1}. NUEVO:      ${nuevo.nombre} — ${nuevo.direccion}`);
    console.log(`   EXISTENTE:  ${existente.name} — ${existente.address}`);
    console.log('');
  });
}

main();
