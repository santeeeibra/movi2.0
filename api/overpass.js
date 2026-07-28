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

// Devuelve { json } si salio bien, o { fallo: 'motivo corto' } si no. Asi
// el caller puede armar un reporte de diagnostico con la causa real de
// cada espejo, en vez de un simple null que no dice nada.
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
    if (!res.ok) {
      const textoError = await res.text().catch(() => '');
      return { fallo: `HTTP ${res.status}${textoError ? ': ' + textoError.slice(0, 200) : ''}` };
    }
    return { json: await res.json() };
  } catch (err) {
    return { fallo: err.name === 'AbortError' ? 'timeout' : (err.message || String(err)) };
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

  // Diagnostico: guardamos que paso con cada espejo, aunque alguno
  // funcione, para poder ver en la consola del navegador si Overpass
  // esta tardando/bloqueando desde el servidor de Vercel.
  const diagnostico = [];

  for (const url of OVERPASS_URLS) {
    const inicio = Date.now();
    const resultado = await consultarOverpass(url, query);
    const ms = Date.now() - inicio;

    if (resultado.json) {
      diagnostico.push({ url, ok: true, ms });
      res.status(200).json({ ...resultado.json, _diagnostico: diagnostico });
      return;
    }
    diagnostico.push({ url, ok: false, ms, motivo: resultado.fallo });
  }

  // Ninguno de los 3 espejos respondio: devolvemos vacio (no error 500),
  // asi el frontend lo trata igual que "sin resultados", pero con el
  // diagnostico adentro para poder ver la causa real en la consola.
  res.status(200).json({ elements: [], _diagnostico: diagnostico });
}
