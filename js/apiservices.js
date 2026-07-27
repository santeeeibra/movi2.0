// ==================================================================
//  Busqueda de direcciones real contra la Geocoding API v5 de Mapbox,
//  restringida siempre a la zona de Viedma/Patagones (nunca nacional).
// ==================================================================
import { MAPBOX_TOKEN } from './config.js';

export const VIEDMA_BBOX = [-63.0500, -40.8600, -62.9000, -40.7500];
export const REGION_BBOX = [-64.5, -41.6, -61.5, -40.0];

const VIEDMA_CENTER = [-62.9961, -40.8124];

function distanciaAproximada(lng, lat) {
  const dLat = lat - VIEDMA_CENTER[1];
  const dLng = lng - VIEDMA_CENTER[0];
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// ==================================================================
//  Busqueda de intersecciones ("RIVADAVIA Y GUIDO", "Rivadavia
//  esquina Guido"). Mapbox Geocoding v5 tiene soporte NATIVO para
//  cruces de calles: si separas los dos nombres con "and" o "&" (en
//  ingles, literal, asi lo espera la API sin importar el idioma de
//  busqueda), y usas types=address, te devuelve el punto exacto del
//  cruce con accuracy:"intersection". Lo unico que hace falta es
//  detectar el patron en español ("Y" / "esquina") y traducirlo a ese
//  formato antes de mandar la consulta.
// ==================================================================
const PATRON_INTERSECCION = /^(.+?)\s+(?:y|esquina(?:\s+con)?)\s+(.+)$/i;

function detectarInterseccion(texto) {
  const match = texto.match(PATRON_INTERSECCION);
  if (!match) return null;
  const calle1 = match[1].trim();
  const calle2 = match[2].trim();
  if (!calle1 || !calle2) return null;
  return { calle1, calle2, consulta: `${calle1} and ${calle2}` };
}

async function buscarConBBox(query, bbox, tipos = 'address,poi') {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
    + `?access_token=${MAPBOX_TOKEN}`
    + `&bbox=${bbox.join(',')}`
    + `&proximity=${VIEDMA_CENTER.join(',')}`
    + `&types=${tipos}`
    + `&language=es`
    + `&limit=5`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return json.features ?? [];
}

// Devuelve maximo 5 resultados { nombre, direccion } ordenados por
// cercania real al centro de Viedma. Reintenta con REGION_BBOX (mas
// amplio, pero nunca nacional) si VIEDMA_BBOX no trae nada.
export async function searchMapbox(query) {
  const texto = (query || '').trim();
  if (!texto) return [];

  const interseccion = detectarInterseccion(texto);
  const textoConsulta = interseccion ? interseccion.consulta : texto;
  // Intersection search de Mapbox solo funciona con types=address (asi
  // lo pide la documentacion) — mezclar poi puede hacer que no matchee.
  const tipos = interseccion ? 'address' : 'address,poi';

  let features = await buscarConBBox(textoConsulta, VIEDMA_BBOX, tipos);
  if (features.length === 0) {
    features = await buscarConBBox(textoConsulta, REGION_BBOX, tipos);
  }

  if (interseccion) {
    // FIX: cuando Mapbox no encuentra el cruce EXACTO entre las dos
    // calles, en vez de devolver vacio suele devolver su "mejor
    // adivinanza" (por ejemplo, el resultado de la primera calle sola,
    // o un punto cercano pero incorrecto) — sin avisar que no es una
    // interseccion real. Esto llevaba al pasajero a un punto
    // equivocado sin ningun aviso. Ahora solo se aceptan resultados
    // que Mapbox marca explicitamente con accuracy:"intersection"
    // (confirmacion real de que encontro el cruce). Si ninguno cumple
    // eso, se descarta todo y se devuelve vacio — mejor "sin
    // resultados" y que el pasajero ajuste el pin a mano, que un
    // resultado que parece preciso pero no lo es.
    features = features.filter((f) => f.properties?.accuracy === 'intersection');
    if (features.length === 0) return [];
  }

  return features
    .map((f) => ({
      // Para intersecciones, mostramos el nombre en español tal como
      // el usuario lo escribio, no el "and" en ingles que le mandamos
      // a la API por dentro.
      nombre: interseccion ? `${interseccion.calle1} y ${interseccion.calle2}` : (f.text ?? f.place_name),
      direccion: f.place_name,
      lng: f.center[0],
      lat: f.center[1],
    }))
    .sort((a, b) => distanciaAproximada(a.lng, a.lat) - distanciaAproximada(b.lng, b.lat));
}

// ==================================================================
//  Ruta real contra la Directions API de Mapbox (perfil driving), que
//  pasa en orden por todos los puntos recibidos: [origen, parada1,
//  parada2, ..., destinoFinal]. Devuelve distancia total en km,
//  duracion total en minutos y la geometria (GeoJSON) del recorrido
//  completo para dibujar la linea en el mapa.
// ==================================================================
export async function getRuta(...puntos) {
  // Compatibilidad: getRuta(origen, destino) sigue funcionando igual
  // que antes, ademas de getRuta([origen, parada1, ..., destino]).
  const lista = puntos.length === 1 && Array.isArray(puntos[0]) ? puntos[0] : puntos;
  if (lista.length < 2) return null;

  const coords = lista.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`
    + `?access_token=${MAPBOX_TOKEN}`
    + `&geometries=geojson`
    + `&overview=full`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const json = await res.json();
  const ruta = json.routes?.[0];
  if (!ruta) return null;

  return {
    km: ruta.distance / 1000,
    minutos: ruta.duration / 60,
    geometry: ruta.geometry,
  };
}
