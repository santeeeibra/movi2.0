// ==================================================================
//  Proxy server-side para Overpass API.
//
//  Por que existe: el navegador NO puede pegarle directo a los
//  servidores de Overpass (overpass-api.de y sus espejos) porque esos
//  servidores no devuelven el header Access-Control-Allow-Origin, y
//  el navegador bloquea la respuesta por política CORS antes de que
//  el código de la app la pueda ver. Esto no es intermitente: pasa
//  siempre, para cualquier sitio, no solo para Movi.
//
//  La solución es que el pedido a Overpass lo haga el SERVIDOR de
//  Vercel (esta función), no el navegador del pasajero. Entre
//  servidores no hay CORS (esa política solo aplica a pedidos hechos
//  desde un navegador). El navegador le pide a esta función (que
//  vive en el mismo origen que la app, asi que no hay CORS de por
//  medio), y esta función le pide a Overpass por atrás.
// ==================================================================
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 6000;

async function consultarOverpass(url, query) {
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controlador.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[Movi] Overpass (${url}) no respondio:`, err.message || err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo no permitido' });
    return;
  }

  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'Falta "query" (string) en el body' });
    return;
  }

  for (const url of OVERPASS_URLS) {
    const json = await consultarOverpass(url, query);
    if (json) {
      res.status(200).json(json);
      return;
    }
  }

  // Ninguno de los 3 espejos respondio: devolvemos vacio en vez de error,
  // asi el codigo del frontend lo trata igual que "sin resultados" (que
  // ya sabe manejar) en vez de romperse con un 502/504.
  res.status(200).json({ elements: [] });
}
