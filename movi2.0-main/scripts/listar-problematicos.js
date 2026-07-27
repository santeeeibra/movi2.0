// ==================================================================
//  Script de SOLO LECTURA: lista registros de "places" con
//  address/direccion NULL, o con name generico tipo "Ubicacion
//  lat,lng", filtrando a los que coincidan con una lista de nombres
//  problematicos detectados a mano. No inserta ni modifica nada.
//  Correr a mano: node scripts/listar-problematicos.js
// ==================================================================
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const NOMBRES_SOSPECHOSOS = [
  'Sanatorio Austral',
  'La Anónima',
  'El Tubo',
  'My Place Gym',
  'Poder Judicial de Río Negro',
  'Playa Central',
];

const REGEX_UBICACION_GENERICA = /^Ubicaci[oó]n\s+-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/i;

async function main() {
  const { data, error } = await supabase.from('places').select('*');

  if (error) {
    console.error('Error consultando Supabase:', error.message);
    return;
  }

  const coincidencias = data.filter((lugar) => {
    const nombreCoincide = NOMBRES_SOSPECHOSOS.some((n) =>
      (lugar.name || '').toLowerCase().includes(n.toLowerCase()),
    );
    if (!nombreCoincide) return false;

    const direccionNula = lugar.address == null || lugar.direccion == null;
    const nombreGenerico = REGEX_UBICACION_GENERICA.test(lugar.name || '');

    return direccionNula || nombreGenerico;
  });

  console.log(`--- ${coincidencias.length} registros encontrados ---\n`);
  coincidencias.forEach((lugar) => {
    console.log(`id: ${lugar.id}`);
    console.log(`  name: ${lugar.name}`);
    console.log(`  address: ${lugar.address}`);
    console.log(`  direccion: ${lugar.direccion}`);
    console.log(`  lat, lng: ${lugar.lat}, ${lugar.lng}`);
    console.log('');
  });
}

main();
