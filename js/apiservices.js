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

async function buscarConBBox(query, bbox) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
    + `?access_token=${MAPBOX_TOKEN}`
    + `&bbox=${bbox.join(',')}`
    + `&proximity=${VIEDMA_CENTER.join(',')}`
    + `&types=address,poi`
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

  let features = await buscarConBBox(texto, VIEDMA_BBOX);
  if (features.length === 0) {
    features = await buscarConBBox(texto, REGION_BBOX);
  }

  return features
    .map((f) => ({
      nombre: f.text ?? f.place_name,
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
