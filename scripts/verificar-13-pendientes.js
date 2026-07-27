import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fSvruT7v9PVsATpxMJXjSQ_Fba2UOS7';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const NOMBRES = [
  'Banco Patagonia (Viedma)',
  'Supermercados La Anónima (Viedma)',
  'Comisaría Primera (Viedma)',
  "Sparta's Gym Patagones",
  'Pista de la Salud y Costanera Viedma',
  'Delegación Municipal El Cóndor',
  'Centro de Atención Primaria de Salud (CAPS El Cóndor)',
  'Hotel Nijar',
  'Banco Credicoop (Viedma)',
  'Shell Atlántico',
  'Centro Municipal de Cultura (Viedma)',
  'Centro Cultural N° 2 - Juan de la Piedra (Viedma)',
  'Faro Río Negro',
];

async function main() {
  const { data, error } = await supabase.from('places').select('*').in('name', NOMBRES);
  if (error) throw new Error(error.message);
  for (const nombre of NOMBRES) {
    const encontrados = data.filter((d) => d.name === nombre);
    if (encontrados.length === 0) {
      console.log(`- ${nombre}: NO ENCONTRADO`);
    } else {
      for (const f of encontrados) {
        console.log(`- ${nombre}: lat=${f.lat}, lng=${f.lng}, verificado=${f.verificado}, direccion="${f.direccion}"`);
      }
    }
  }
}

main();
