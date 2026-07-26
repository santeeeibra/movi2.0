import { createClient } from '@supabase/supabase-js';
import { MAPBOX_TOKEN } from '../js/config.js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BBOX_VIEDMA_PATAGONES = '-63.15,-41.10,-62.85,-40.70';

const LUGARES = [
  { nombre: 'Banco Patagonia (Viedma)', direccion: 'Sarmiento 373, Viedma, Río Negro' },
  { nombre: 'Supermercados La Anónima (Viedma)', direccion: 'Álvaro Barros 1408, Viedma, Río Negro' },
  { nombre: 'Comisaría Primera (Viedma)', direccion: 'Alem 149, Viedma, Río Negro' },
  { nombre: "Sparta's Gym Patagones", direccion: 'Monseñor José Fagnano 359, Carmen de Patagones, Buenos Aires' },
  { nombre: 'Pista de la Salud y Costanera Viedma', direccion: 'Av. Francisco de Viedma, Viedma, Río Negro' },
  { nombre: 'Delegación Municipal El Cóndor', direccion: 'Calle 69 y Calle 8, El Cóndor, Río Negro' },
  { nombre: 'Centro de Atención Primaria de Salud (CAPS El Cóndor)', direccion: 'Calle 69 y Calle 8, El Cóndor, Río Negro' },
  { nombre: 'Hotel Nijar', direccion: 'Mitre 490, Viedma, Río Negro' },
  { nombre: 'Banco Credicoop (Viedma)', direccion: 'Garrone 267, Viedma, Río Negro' },
  { nombre: 'Centro Municipal de Cultura (Viedma)', direccion: 'Gallardo 550, Viedma, Río Negro' },
  { nombre: 'Centro Cultural N° 2 - Juan de la Piedra (Viedma)', direccion: 'Mitre 849, Viedma, Río Negro' },
  { nombre: 'Faro Río Negro', direccion: 'Ruta Provincial 1, km 37, Balneario El Cóndor, Río Negro' },
];

const METROS_POR_GRADO_LAT = 111320;
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocodificar(direccion) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(direccion)}.json`
    + `?access_token=${MAPBOX_TOKEN}&country=ar&language=es&limit=1&bbox=${BBOX_VIEDMA_PATAGONES}`;
  const res = await fetch(url);
  const json = await res.json();
  const feature = json.features?.[0];
  const [lng, lat] = feature.center;
  return { lat, lng };
}

const { data: todos, error } = await supabase.from('places').select('*');
if (error) throw new Error(error.message);

for (const lugar of LUGARES) {
  const { lat, lng } = await geocodificar(lugar.direccion);
  const cercanos = todos
    .map((p) => ({ ...p, dist: distanciaMetros(lat, lng, p.lat, p.lng) }))
    .filter((p) => p.dist <= 30)
    .sort((a, b) => a.dist - b.dist);
  console.log(`\n${lugar.nombre} (geocoded lat=${lat}, lng=${lng}):`);
  if (cercanos.length === 0) {
    console.log('  ninguno cercano');
  } else {
    for (const c of cercanos) {
      console.log(`  -> "${c.name}" a ${c.dist.toFixed(1)}m (lat=${c.lat}, lng=${c.lng}, verificado=${c.verificado})`);
    }
  }
}
