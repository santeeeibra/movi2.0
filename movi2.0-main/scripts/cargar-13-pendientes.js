// ==================================================================
//  Script de carga puntual: los 13 lugares que quedaron pendientes
//  de la carga anterior (7 ya confirmados + 6 que necesitaban
//  direccion, ya conseguida). Con dedup por cercania (15m) igual
//  que cargar-lugares-clave.js.
//  Correr a mano: node scripts/cargar-13-pendientes.js
// ==================================================================
import { createClient } from '@supabase/supabase-js';
import { MAPBOX_TOKEN } from '../js/config.js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const RADIO_DEDUP_METROS = 15;
const METROS_POR_GRADO_LAT = 111320;

const LUGARES = [
  { nombre: 'Banco Patagonia (Viedma)', direccion: 'Sarmiento 373, Viedma, Río Negro', categoria: 'Banco' },
  { nombre: 'Supermercados La Anónima (Viedma)', direccion: 'Álvaro Barros 1408, Viedma, Río Negro', categoria: 'Supermercado' },
  { nombre: 'Comisaría Primera (Viedma)', direccion: 'Alem 149, Viedma, Río Negro', categoria: 'Seguridad' },
  { nombre: "Sparta's Gym Patagones", direccion: 'Monseñor José Fagnano 359, Carmen de Patagones, Buenos Aires', categoria: 'Gimnasio' },
  { nombre: 'Pista de la Salud y Costanera Viedma', direccion: 'Av. Francisco de Viedma, Viedma, Río Negro', categoria: 'Recreación' },
  { nombre: 'Delegación Municipal El Cóndor', direccion: 'Calle 69 y Calle 8, El Cóndor, Río Negro', categoria: 'Balneario El Cóndor' },
  { nombre: 'Centro de Atención Primaria de Salud (CAPS El Cóndor)', direccion: 'Calle 69 y Calle 8, El Cóndor, Río Negro', categoria: 'Balneario El Cóndor' },

  { nombre: 'Hotel Nijar', direccion: 'Mitre 490, Viedma, Río Negro', categoria: 'Hotel' },
  { nombre: 'Banco Credicoop (Viedma)', direccion: 'Garrone 267, Viedma, Río Negro', categoria: 'Banco' },
  { nombre: 'Shell Atlántico', direccion: 'Av. Cardenal Cagliero 1475 esq. Tucumán, Viedma, Río Negro', categoria: 'Estación de servicio' },
  { nombre: 'Centro Municipal de Cultura (Viedma)', direccion: 'Gallardo 550, Viedma, Río Negro', categoria: 'Cultura' },
  { nombre: 'Centro Cultural N° 2 - Juan de la Piedra (Viedma)', direccion: 'Mitre 849, Viedma, Río Negro', categoria: 'Cultura' },
  { nombre: 'Faro Río Negro', direccion: 'Ruta Provincial 1, km 37, Balneario El Cóndor, Río Negro', categoria: 'Balneario El Cóndor' },
];

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
  return { lat, lng, placeName: feature.place_name, relevance: feature.relevance };
}

// Bbox aproximado de la costa de El Cóndor - para chequear que el
// geocoding del faro cae efectivamente sobre el acantilado costero y
// no en un punto generico tierra adentro.
const BBOX_COSTA_EL_CONDOR = { minLat: -41.05, maxLat: -40.90, minLng: -63.05, maxLng: -62.85 };

function estaEnCostaElCondor(lat, lng) {
  return (
    lat >= BBOX_COSTA_EL_CONDOR.minLat
    && lat <= BBOX_COSTA_EL_CONDOR.maxLat
    && lng >= BBOX_COSTA_EL_CONDOR.minLng
    && lng <= BBOX_COSTA_EL_CONDOR.maxLng
  );
}

async function main() {
  let insertados = 0;
  let salteados = 0;
  let fallidos = 0;
  let faroRevisarManual = false;

  for (const lugar of LUGARES) {
    try {
      const { lat, lng, placeName, relevance } = await geocodificar(lugar.direccion);

      if (lugar.nombre === 'Faro Río Negro' && !estaEnCostaElCondor(lat, lng)) {
        console.log(`- ${lugar.nombre}: NO INSERTADO - geocoding no cayo en la costa de El Condor (${lat}, ${lng} / "${placeName}"). Revisar manualmente.`);
        faroRevisarManual = true;
        fallidos += 1;
        continue;
      }

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

      const nota = lugar.nombre === 'Faro Río Negro' ? ` (relevance ${relevance}, "${placeName}")` : '';
      console.log(`- ${lugar.nombre}: OK${nota}`);
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
  if (faroRevisarManual) {
    console.log('\nATENCION: Faro Rio Negro necesita revision manual de coordenadas.');
  }
}

main();
