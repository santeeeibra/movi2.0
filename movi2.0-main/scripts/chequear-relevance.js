import { MAPBOX_TOKEN } from '../js/config.js';

const BBOX_VIEDMA_PATAGONES = '-63.15,-41.10,-62.85,-40.70';

const LUGARES = [
  { nombre: 'Banco Patagonia (Viedma)', direccion: 'Sarmiento 373, Viedma, Río Negro' },
  { nombre: 'Supermercados La Anónima (Viedma)', direccion: 'Álvaro Barros 1408, Viedma, Río Negro' },
  { nombre: 'Comisaría Primera (Viedma)', direccion: 'Alem 149, Viedma, Río Negro' },
  { nombre: "Sparta's Gym Patagones", direccion: 'Monseñor José Fagnano 359, Carmen de Patagones, Buenos Aires' },
  { nombre: 'Pista de la Salud y Costanera Viedma', direccion: 'Av. Francisco de Viedma, Viedma, Río Negro' },
  { nombre: 'Delegación Municipal El Cóndor', direccion: 'Calle 69 y Calle 8, El Cóndor, Río Negro' },
  { nombre: 'CAPS El Cóndor', direccion: 'Calle 69 y Calle 8, El Cóndor, Río Negro' },
  { nombre: 'Hotel Nijar', direccion: 'Mitre 490, Viedma, Río Negro' },
  { nombre: 'Banco Credicoop', direccion: 'Garrone 267, Viedma, Río Negro' },
  { nombre: 'Shell Atlántico', direccion: 'Av. Cardenal Cagliero 1475 esq. Tucumán, Viedma, Río Negro' },
  { nombre: 'Centro Municipal de Cultura', direccion: 'Gallardo 550, Viedma, Río Negro' },
  { nombre: 'Centro Cultural N°2', direccion: 'Mitre 849, Viedma, Río Negro' },
  { nombre: 'Faro Río Negro', direccion: 'Ruta Provincial 1, km 37, Balneario El Cóndor, Río Negro' },
];

for (const lugar of LUGARES) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(lugar.direccion)}.json`
    + `?access_token=${MAPBOX_TOKEN}&country=ar&language=es&limit=1&bbox=${BBOX_VIEDMA_PATAGONES}`;
  const res = await fetch(url);
  const json = await res.json();
  const f = json.features?.[0];
  console.log(`${lugar.nombre}: relevance=${f?.relevance} accuracy=${f?.properties?.accuracy} place_name="${f?.place_name}" [${f?.center}]`);
}
