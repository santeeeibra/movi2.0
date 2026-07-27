// ==================================================================
//  Script de carga puntual: inserta directo en Supabase (tabla
//  "places") los 16 lugares que habian quedado afuera por falso
//  positivo de dedup. SIN chequeo de dedup - correr una sola vez.
//  Correr a mano: node scripts/cargar-16-sin-dedup.js
// ==================================================================
import { createClient } from '@supabase/supabase-js';
import { MAPBOX_TOKEN } from '../js/config.js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BBOX_VIEDMA_PATAGONES = '-63.15,-41.10,-62.85,-40.70';

const NOMBRES = [
  'Hotel Nijar',
  'Banco Patagonia (Viedma)',
  'Banco Credicoop (Viedma)',
  'Supermercados La Anónima (Viedma)',
  'Shell Atlántico',
  'Comisaría Primera (Viedma)',
  'Edificio de Tribunales del Poder Judicial de Río Negro',
  'Centro Municipal de Cultura (Viedma)',
  'Centro Cultural N° 2 - Juan de la Piedra (Viedma)',
  'Teatro El Tubo (Viedma)',
  "Sparta's Gym Patagones",
  'Pista de la Salud y Costanera Viedma',
  'Informes Turísticos Carmen de Patagones',
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
  return { lat, lng };
}

async function main() {
  const contenido = await (await import('node:fs/promises')).readFile(
    new URL('../data/lugares-clave.json', import.meta.url),
    'utf-8',
  );
  const lugares = JSON.parse(contenido);
  const seleccionados = lugares.filter((l) => NOMBRES.includes(l.nombre));

  const faltantes = NOMBRES.filter((n) => !seleccionados.some((l) => l.nombre === n));
  if (faltantes.length > 0) {
    console.log('ATENCION - no se encontraron en el JSON:', faltantes);
  }

  let insertados = 0;
  let fallidos = 0;

  for (const lugar of seleccionados) {
    try {
      const { lat, lng } = await geocodificar(lugar.direccion);

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
  console.log(`Fallidos: ${fallidos}`);
}

main();
