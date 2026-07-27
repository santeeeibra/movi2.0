// ==================================================================
//  Script de SOLO LECTURA: geocodifica con Mapbox una lista puntual
//  de lugares del JSON y muestra el lat/lng resultante. No inserta
//  ni modifica nada en Supabase.
//  Correr a mano: node scripts/ver-geocoding-12.js
// ==================================================================
import { readFile } from 'node:fs/promises';
import { MAPBOX_TOKEN } from '../js/config.js';

const BBOX_VIEDMA_PATAGONES = '-63.15,-41.10,-62.85,-40.70';

const NOMBRES = [
  'Hotel Nijar',
  'Banco Patagonia (Viedma)',
  'Banco Credicoop (Viedma)',
  'Supermercados La Anónima (Viedma)',
  'Shell Atlántico',
  'Comisaría Primera (Viedma)',
  'Centro Municipal de Cultura (Viedma)',
  'Centro Cultural N° 2 - Juan de la Piedra (Viedma)',
  "Sparta's Gym Patagones",
  'Pista de la Salud y Costanera Viedma',
  'Faro Río Negro',
  'Delegación Municipal El Cóndor',
  'Centro de Atención Primaria de Salud (CAPS El Cóndor)',
];

async function geocodificar(direccion) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(direccion)}.json`
    + `?access_token=${MAPBOX_TOKEN}&country=ar&language=es&limit=1&bbox=${BBOX_VIEDMA_PATAGONES}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox respondio ${res.status}`);
  const json = await res.json();
  const feature = json.features?.[0];
  if (!feature) throw new Error('Sin resultados de geocoding');
  const [lng, lat] = feature.center;
  return { lat, lng, lugarEncontrado: feature.place_name };
}

async function main() {
  const contenido = await readFile(new URL('../data/lugares-clave.json', import.meta.url), 'utf-8');
  const lugares = JSON.parse(contenido);
  const seleccionados = lugares.filter((l) => NOMBRES.includes(l.nombre));

  const faltantes = NOMBRES.filter((n) => !seleccionados.some((l) => l.nombre === n));
  if (faltantes.length > 0) {
    console.log('ATENCION - no se encontraron en el JSON:', faltantes, '\n');
  }

  for (const lugar of seleccionados) {
    try {
      const { lat, lng, lugarEncontrado } = await geocodificar(lugar.direccion);
      console.log(`- ${lugar.nombre}`);
      console.log(`    direccion JSON: ${lugar.direccion}`);
      console.log(`    lat, lng: ${lat}, ${lng}`);
      console.log(`    mapbox place_name: ${lugarEncontrado}`);
      console.log('');
    } catch (err) {
      console.log(`- ${lugar.nombre}: ERROR (${err.message})\n`);
    }
  }
}

main();
