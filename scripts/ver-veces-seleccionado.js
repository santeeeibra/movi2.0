// ==================================================================
//  Script de SOLO LECTURA: muestra veces_seleccionado para una lista
//  puntual de ids de "places". No inserta ni modifica nada.
//  Correr a mano: node scripts/ver-veces-seleccionado.js
// ==================================================================
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const IDS = [
  '21086aa3-548f-4a0f-8ebb-375095c16311',
  '19a0df4c-b8c1-4dee-9ba2-faf1779c83c8',
  'ec273775-6511-4896-9ac4-e0ef425bb7e8',
  '305aa18a-5f9b-4a0c-90d6-bf998eb3586e',
];

async function main() {
  const { data, error } = await supabase.from('places').select('*').in('id', IDS);

  if (error) {
    console.error('Error consultando Supabase:', error.message);
    return;
  }

  data.forEach((lugar) => {
    console.log(`id: ${lugar.id}`);
    console.log(`  name: ${lugar.name}`);
    console.log(`  veces_seleccionado: ${lugar.veces_seleccionado}`);
    console.log('');
  });
}

main();
