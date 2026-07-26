// ==================================================================
//  Movi — reinicio limpio. Solo lo esencial: mostrar el mapa.
// ==================================================================

import * as Sentry from '@sentry/browser';
import { supabase, getLugares, searchLugares, reverseGeocode, registrarSeleccionDeLugar, distanciaMetros } from './databaseservice.js';
import { MAPBOX_TOKEN } from './config.js';
import { searchMapbox, getRuta } from './apiservices.js';
import { initMonitoring } from './monitoring.js';

Sentry.init({
  dsn: "https://7bc90b9a17ed004fbac2a7997ab37093@o4511797812920320.ingest.de.sentry.io/4511797825437776",
  integrations: [],
  tracesSampleRate: 1.0,
});

initMonitoring();

// Registro del service worker. Solo en produccion para no interferir con Vite.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const registrarSW = () => navigator.serviceWorker.register('/service-worker.js');
  if (document.readyState === 'complete') {
    registrarSW();
  } else {
    window.addEventListener('load', registrarSW);
  }
}

// ==================================================================
//  Referencias a elementos DOM (se necesitan antes del bloque de login
//  porque bloquearApp() los usa)
// ==================================================================
const origenToast = document.getElementById('origen-toast');
const btnPedirViaje = document.getElementById('btn-pedir-viaje');
const btnConfirmarOrigen = document.getElementById('btn-confirmar-origen');
const btnVolverUbicacion = document.getElementById('btn-volver-ubicacion');
const searchInput = document.getElementById('search-input');
const resultsList = document.getElementById('results-list');
const resultsLabel = document.getElementById('results-label');

const btnAgregarParada = document.getElementById('btn-agregar-parada');
const btnModificarDestino = document.getElementById('btn-modificar-destino');
const btnVerParadas = document.getElementById('btn-ver-paradas');
const paradasCount = document.getElementById('paradas-count');
const paradasOverlay = document.getElementById('paradas-overlay');
const paradasPanelList = document.getElementById('paradas-panel-list');
const btnCerrarParadas = document.getElementById('btn-cerrar-paradas');

let destinoActual = null;

// Lista ordenada de paradas del viaje; la ultima es siempre el destino
// final. modoBusqueda decide que hace la proxima seleccion de direccion:
// null = reemplaza el destino final (comportamiento de siempre), 'agregar-parada'
// = suma una parada nueva al final de la lista.
let paradas = [];
let modoBusqueda = null;

// Referencia al viaje activo del pasajero (id + estado), para saber en que
// etapa esta y decidir donde centrar el mapa (ver btn-centrar-mapa). Se
// completa/actualiza en el flujo de "Pedir viaje" mas abajo.
let viajeActivoPasajero = null;

// Posicion actual (ya interpolada/enganchada a la calle) del auto del
// conductor en movimiento. La alimenta aplicarNuevaPosicionConductor().
let posicionConductor = null;

// Geometria (array de [lng,lat]) de la ultima ruta dibujada en el mapa.
// Se usa para "enganchar" el icono del auto a la calle en vez de mostrarlo
// flotando en el punto crudo del GPS (que puede caer en una vereda, un
// techo, etc. por el margen de error normal del GPS).
let rutaGeometriaActual = null;

// Estado de sesion del conductor (Fases 1-5). Se declaran aca arriba, no
// junto al resto de esa logica mas abajo, porque iniciarSupervisionViajeConductor()
// se llama de forma sincronica durante la carga inicial de la pagina (ver
// "Inicial: decidir que mostrar" un poco mas abajo) y necesita asignar
// conductorTelefonoActual ya mismo — si estas variables estuvieran
// declaradas con let/const mas abajo en el archivo, esa asignacion
// fallaria con un error de "variable no inicializada" (temporal dead zone).
let conductorTelefonoActual = null;   // telefono del conductor logueado en esta sesion
let conductorDisponible = false;      // espejo local de conductores.disponible
let conductorViajeActivo = null;      // viaje en curso de este conductor (o null)
let canalPendientesConductor = null;  // suscripcion Realtime a viajes pendientes

// ==================================================================
//  Login rapido sin contraseña (localStorage + Supabase usuarios)
// ==================================================================
const LS_KEY = 'movi_usuario';
const loginOverlay = document.getElementById('login-overlay');
const loginNombre = document.getElementById('login-nombre');
const loginTelefono = document.getElementById('login-telefono');
const loginErrorNombre = document.getElementById('login-error-nombre');
const loginErrorTelefono = document.getElementById('login-error-telefono');
const btnLoginContinuar = document.getElementById('btn-login-continuar');

function cargarUsuario() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function guardarUsuario(nombre, telefono) {
  const usuario = { nombre, telefono };
  localStorage.setItem(LS_KEY, JSON.stringify(usuario));
  return usuario;
}

function limpiarErroresLogin() {
  loginNombre.classList.remove('error');
  loginTelefono.classList.remove('error');
  loginErrorNombre.classList.remove('show');
  loginErrorTelefono.classList.remove('show');
}

function mostrarErrorLogin(inputEl, errorEl, mensaje) {
  inputEl.classList.add('error');
  errorEl.textContent = mensaje;
  errorEl.classList.add('show');
}

function formatearTelefonoConPrefijo(digitos) {
  // Si ya empieza con 549, no duplicamos
  if (digitos.startsWith('549')) return digitos;
  // Si empieza con +549, sacamos el +
  if (digitos.startsWith('+549')) return digitos.slice(1);
  // En cualquier otro caso, agregamos 549 adelante
  return '549' + digitos;
}

function validarLogin(nombre, telefono) {
  let valido = true;
  limpiarErroresLogin();

  if (!nombre.trim()) {
    mostrarErrorLogin(loginNombre, loginErrorNombre, 'Ingresá tu nombre');
    valido = false;
  }

  const soloNumeros = telefono.replace(/\D/g, '');
  if (!soloNumeros || soloNumeros.length < 8) {
    mostrarErrorLogin(loginTelefono, loginErrorTelefono, 'Número inválido (mín. 8 dígitos)');
    valido = false;
  }

  return valido ? { nombre: nombre.trim(), telefono: soloNumeros } : null;
}

async function upsertUsuario(nombre, telefono) {
  const { error } = await supabase
    .from('usuarios')
    .upsert({ telefono, nombre }, { onConflict: 'telefono' });

  if (error) {
    console.error('[Movi] Error guardando usuario en Supabase:', error);
  }
}

function aplicarUsuarioEnPerfil(usuario) {
  const avatar = document.querySelector('#perfil-drawer .driver-avatar');
  const nombreEl = document.querySelector('#perfil-drawer .driver-name');
  const emailEl = document.querySelector('#perfil-drawer .perfil-email');

  if (usuario) {
    avatar.textContent = usuario.nombre.charAt(0).toUpperCase();
    nombreEl.textContent = usuario.nombre;
    if (emailEl) emailEl.style.display = 'none';
  }
}

function bloquearApp(bloqueado) {
  btnPedirViaje.disabled = bloqueado || !destinoActual;
  searchInput.disabled = bloqueado;
  if (bloqueado) {
    searchInput.placeholder = 'Iniciá sesión primero';
  } else {
    searchInput.placeholder = 'Buscar dirección o lugar...';
  }
}

// ==================================================================
//  Role-based routing: pasajero / conductor
// ==================================================================
const roleSelectOverlay = document.getElementById('role-select-overlay');
const conductorFormOverlay = document.getElementById('conductor-form-overlay');
const driverWaitingOverlay = document.getElementById('driver-waiting-overlay');

const btnSoyPasajero = document.getElementById('btn-soy-pasajero');
const btnSoyConductor = document.getElementById('btn-soy-conductor');

// Conductor form fields
const conductorNombre = document.getElementById('conductor-nombre');
const conductorTelefono = document.getElementById('conductor-telefono');
const conductorPatente = document.getElementById('conductor-patente');
const conductorModelo = document.getElementById('conductor-modelo');
const conductorColor = document.getElementById('conductor-color');
const btnGuardarConductor = document.getElementById('btn-guardar-conductor');
const conductorMsg = document.getElementById('conductor-msg');

function mostrarOverlay(el) {
  [roleSelectOverlay, loginOverlay, conductorFormOverlay, driverWaitingOverlay]
    .forEach(o => o.classList.remove('show'));
  if (el) el.classList.add('show');
}

function ocultarLoginYApp() {
  // Hide map UI elements when showing role screens
  inicioMapa = true; // prevent map init if we're going to show something else
}

// Inicial: decidir qué mostrar según localStorage
const rol = localStorage.getItem('rol');
const conductorTelefonoLS = localStorage.getItem('conductor_telefono');
const usuarioExistente = cargarUsuario();

if (rol === 'conductor') {
  if (conductorTelefonoLS) {
    // Conductor ya registrado → pantalla de espera
    mostrarOverlay(driverWaitingOverlay);
    bloquearApp(true);
    iniciarSupervisionViajeConductor(conductorTelefonoLS);
  } else {
    // Conductor sin datos → formulario
    mostrarOverlay(conductorFormOverlay);
    bloquearApp(true);
  }
} else if (rol === 'pasajero') {
  const pasajeroTelefonoLS = localStorage.getItem('pasajero_telefono');
  if (pasajeroTelefonoLS) {
    // Pasajero ya logueado → app normal
    mostrarOverlay(null);
    bloquearApp(false);
    if (usuarioExistente) {
      aplicarUsuarioEnPerfil(usuarioExistente);
    }
  } else {
    // Pasajero sin datos → login de pasajero
    mostrarOverlay(loginOverlay);
    bloquearApp(true);
  }
} else {
  // Sin rol → elegir
  mostrarOverlay(roleSelectOverlay);
  bloquearApp(true);
}

// "Soy Pasajero"
btnSoyPasajero.addEventListener('click', () => {
  localStorage.setItem('rol', 'pasajero');
  mostrarOverlay(loginOverlay);
  bloquearApp(true);
});

// "Soy Conductor"
btnSoyConductor.addEventListener('click', () => {
  localStorage.setItem('rol', 'conductor');
  mostrarOverlay(conductorFormOverlay);
  bloquearApp(true);
});

// Guardar datos del conductor en Supabase
async function upsertConductor(nombre, telefono, patente, modeloAuto, colorAuto) {
  const { error } = await supabase
    .from('conductores')
    .upsert(
      { telefono, nombre, patente, modelo_auto: modeloAuto, color_auto: colorAuto },
      { onConflict: 'telefono' }
    );
  return error;
}

// Busca un conductor real para asignarle un viaje: preferimos uno marcado
// disponible = true; si no hay ninguno asi (o la columna esta vacia en
// todas las filas), caemos a cualquier conductor registrado. Devuelve
// null si la tabla "conductores" todavia no tiene ninguna fila.
async function buscarConductorDisponible() {
  const { data: disponible, error: errorDisponible } = await supabase
    .from('conductores')
    .select('*')
    .eq('disponible', true)
    .limit(1)
    .maybeSingle();

  if (errorDisponible) {
    console.error('[Movi] Error buscando conductor disponible:', errorDisponible);
  }
  if (disponible) return disponible;

  const { data: cualquiera, error: errorCualquiera } = await supabase
    .from('conductores')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (errorCualquiera) {
    console.error('[Movi] Error buscando conductor de respaldo:', errorCualquiera);
    return null;
  }
  return cualquiera;
}

// A partir de una fila real de "conductores", arma los campos que se
// escriben en "viajes" para dejar asignado ese conductor (con fallback
// si todavia no hay ninguno registrado, para no romper la demo).
function datosConductorParaViaje(conductor, nombreFallback) {
  if (!conductor) return { nombre_conductor: nombreFallback };

  return {
    nombre_conductor: conductor.nombre,
    conductor_telefono: conductor.telefono,
    patente_conductor: conductor.patente,
    modelo_auto_conductor: conductor.modelo_auto,
    color_auto_conductor: conductor.color_auto,
  };
}

btnGuardarConductor.addEventListener('click', async () => {
  const nombre = conductorNombre.value.trim();
  const esAdminConductor = nombre.toLowerCase() === 'admin'
    && conductorTelefono.value.trim().toLowerCase() === 'admin';
  const telefonoRaw = esAdminConductor
    ? TELEFONO_ADMIN
    : conductorTelefono.value.replace(/\D/g, '');
  const patente = conductorPatente.value.trim().toUpperCase();
  const modeloAuto = conductorModelo.value.trim();
  const colorAuto = conductorColor.value.trim();

  if (!nombre) {
    conductorMsg.textContent = 'Ingresá tu nombre y apellido';
    conductorMsg.style.color = '#C0392B';
    return;
  }
  if (!esAdminConductor && (!telefonoRaw || telefonoRaw.length < 8)) {
    conductorMsg.textContent = 'WhatsApp inválido (mín. 8 dígitos)';
    conductorMsg.style.color = '#C0392B';
    return;
  }
  if (!patente) {
    conductorMsg.textContent = 'Ingresá la patente';
    conductorMsg.style.color = '#C0392B';
    return;
  }
  if (!modeloAuto) {
    conductorMsg.textContent = 'Ingresá el modelo del auto';
    conductorMsg.style.color = '#C0392B';
    return;
  }
  if (!colorAuto) {
    conductorMsg.textContent = 'Ingresá el color del auto';
    conductorMsg.style.color = '#C0392B';
    return;
  }

  const telefono = formatearTelefonoConPrefijo(telefonoRaw);

  btnGuardarConductor.disabled = true;
  btnGuardarConductor.textContent = 'Guardando...';
  conductorMsg.textContent = '';
  conductorMsg.style.color = '';

  const error = await upsertConductor(nombre, telefono, patente, modeloAuto, colorAuto);

  if (error) {
    console.error('[Movi] Error guardando conductor:', error);
    conductorMsg.textContent = 'Error al guardar. Intentá de nuevo.';
    conductorMsg.style.color = '#C0392B';
    btnGuardarConductor.disabled = false;
    btnGuardarConductor.textContent = 'Ingresar';
    return;
  }

  // Persistir rol + teléfono
  localStorage.setItem('rol', 'conductor');
  localStorage.setItem('conductor_telefono', telefono);
  if (esAdminConductor) {
    localStorage.setItem('es_admin', 'true');
    actualizarVisibilidadDevBtn();
  }

  btnGuardarConductor.textContent = '¡Listo!';
  mostrarOverlay(driverWaitingOverlay);
  btnGuardarConductor.disabled = false;
  btnGuardarConductor.textContent = 'Ingresar';
  iniciarSupervisionViajeConductor(telefono);
});

const TELEFONO_ADMIN = '2920605208';

// Evento del boton Continuar (pasajero)
btnLoginContinuar.addEventListener('click', async () => {
  const esAdmin = loginNombre.value.trim().toLowerCase() === 'admin'
    && loginTelefono.value.trim().toLowerCase() === 'admin';

  let datos;
  if (esAdmin) {
    limpiarErroresLogin();
    datos = { nombre: loginNombre.value.trim(), telefono: TELEFONO_ADMIN };
  } else {
    datos = validarLogin(loginNombre.value, loginTelefono.value);
    if (!datos) return;
  }

  btnLoginContinuar.disabled = true;
  btnLoginContinuar.textContent = 'Guardando...';

  const telefonoConPrefijo = formatearTelefonoConPrefijo(datos.telefono);

  await upsertUsuario(datos.nombre, telefonoConPrefijo);

  const usuario = guardarUsuario(datos.nombre, telefonoConPrefijo);
  aplicarUsuarioEnPerfil(usuario);

  localStorage.setItem('rol', 'pasajero');
  localStorage.setItem('pasajero_telefono', telefonoConPrefijo);
  if (esAdmin) {
    localStorage.setItem('es_admin', 'true');
    actualizarVisibilidadDevBtn();
  }
  mostrarOverlay(null);
  bloquearApp(false);

  btnLoginContinuar.disabled = false;
  btnLoginContinuar.textContent = 'Continuar';
});

// ==================================================================
//  Tracking GPS del conductor: solo corre mientras tiene un viaje en
//  curso (para no gastar bateria el resto del tiempo). Se activa/
//  desactiva solo, siguiendo los cambios de "viajes.conductor_telefono"
//  en tiempo real.
//
//  OJO: "viajes" ya tiene la columna conductor_telefono (la revisamos
//  contra la base), pero HOY nada en el codigo la completa — el paso
//  "conductor_asignado" del flujo de "Pedir viaje" (mas abajo) esta
//  simulado con un nombre de conductor hardcodeado y nunca escribe ese
//  telefono. Esta supervision queda lista y correcta para cuando exista
//  una asignacion real, pero en el flujo actual no se va a disparar
//  sola todavia (ver el resumen que le doy al usuario aparte).
// ==================================================================
const ESTADOS_VIAJE_INACTIVO_CONDUCTOR = ['pendiente', 'finalizado', 'cancelado'];

let watchIdConductor = null;
let posicionAnteriorConductor = null;
let ultimoEnvioGpsConductor = 0;
let canalViajeConductor = null;

// Formula de rumbo (bearing) entre dos coordenadas, en grados 0-360.
// Respaldo para cuando el navegador no manda coords.heading (muy comun
// con poca velocidad, GPS de baja precision, o en desktop).
function calcularRumbo(origen, destino) {
  const rad = Math.PI / 180;
  const lat1 = origen.lat * rad;
  const lat2 = destino.lat * rad;
  const dLng = (destino.lng - origen.lng) * rad;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const rumbo = Math.atan2(y, x) / rad;

  return (rumbo + 360) % 360;
}

async function enviarPosicionConductor(telefono, lat, lng, heading) {
  const { error } = await supabase
    .from('conductores')
    .update({ lat, lng, heading, actualizado_en: new Date().toISOString() })
    .eq('telefono', telefono);

  if (error) {
    console.error('[Movi] Error actualizando posicion del conductor:', error);
  }
}

function iniciarTrackingConductor(telefono) {
  if (watchIdConductor !== null) return; // ya esta corriendo
  if (!('geolocation' in navigator)) return;

  posicionAnteriorConductor = null;
  ultimoEnvioGpsConductor = 0;

  watchIdConductor = navigator.geolocation.watchPosition(
    (pos) => {
      const actual = { lat: pos.coords.latitude, lng: pos.coords.longitude };

      let heading = pos.coords.heading;
      if (heading === null || heading === undefined || Number.isNaN(heading)) {
        heading = posicionAnteriorConductor ? calcularRumbo(posicionAnteriorConductor, actual) : null;
      }

      // Como maximo un envio cada 3s, salvo el primer fix (mandarlo de una).
      const ahora = Date.now();
      if (ultimoEnvioGpsConductor === 0 || ahora - ultimoEnvioGpsConductor >= 3000) {
        ultimoEnvioGpsConductor = ahora;
        enviarPosicionConductor(telefono, actual.lat, actual.lng, heading);
      }

      posicionAnteriorConductor = actual;
    },
    (err) => {
      console.error('[Movi] Error obteniendo ubicacion del conductor:', err);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
}

function detenerTrackingConductor() {
  if (watchIdConductor !== null) {
    navigator.geolocation.clearWatch(watchIdConductor);
    watchIdConductor = null;
  }
  posicionAnteriorConductor = null;
  ultimoEnvioGpsConductor = 0;
}

// ==================================================================
//  FASES 1-5 — Disponibilidad, lista de pendientes, aceptar viaje,
//  vista de viaje activo, y vuelta a disponible al terminar.
// ==================================================================
const toggleDisponible = document.getElementById('toggle-disponible');
const driverDisponibleLabel = document.getElementById('driver-disponible-label');
const driverPendingEmpty = document.getElementById('driver-pending-empty');
const driverPendingList = document.getElementById('driver-pending-list');

const driverActiveSheet = document.getElementById('driver-active-sheet');
const driverActiveTitulo = document.getElementById('driver-active-titulo');
const driverActiveInfo = document.getElementById('driver-active-info');
const btnConductorLlegue = document.getElementById('btn-conductor-llegue');
const btnConductorIniciar = document.getElementById('btn-conductor-iniciar');
const btnConductorFinalizar = document.getElementById('btn-conductor-finalizar');

function actualizarToggleUI() {
  toggleDisponible.setAttribute('aria-checked', String(conductorDisponible));
  driverDisponibleLabel.textContent = conductorDisponible ? 'Disponible' : 'No disponible';
  driverPendingEmpty.style.display = conductorDisponible ? 'none' : 'block';
  driverPendingList.style.display = conductorDisponible ? 'flex' : 'none';
}

// ---- FASE 2: lista de viajes pendientes (realtime) ----
async function refrescarListaPendientes() {
  const { data: viajesPendientes, error } = await supabase
    .from('viajes')
    .select('*')
    .eq('estado', 'pendiente')
    .is('conductor_telefono', null)
    .order('creado_en', { ascending: false });

  if (error) {
    console.error('[Movi] Error trayendo viajes pendientes:', error);
    return;
  }

  // TODO (mejora futura): filtrar por cercania real al conductor en vez de
  // traer todos los pendientes de la ciudad entera.
  let paradasPorViaje = {};
  if (viajesPendientes.length > 0) {
    const ids = viajesPendientes.map((v) => v.id);
    const { data: paradasData } = await supabase
      .from('paradas')
      .select('*')
      .in('viaje_id', ids)
      .order('orden', { ascending: true });
    (paradasData || []).forEach((p) => {
      if (!paradasPorViaje[p.viaje_id]) paradasPorViaje[p.viaje_id] = [];
      paradasPorViaje[p.viaje_id].push(p);
    });
  }

  renderListaPendientes(viajesPendientes, paradasPorViaje);
}

function textoHaceCuanto(fechaISO) {
  const minutos = Math.max(0, Math.round((Date.now() - new Date(fechaISO).getTime()) / 60000));
  if (minutos < 1) return 'recién';
  if (minutos === 1) return 'hace 1 min';
  return `hace ${minutos} min`;
}

function renderListaPendientes(viajes, paradasPorViaje) {
  if (!conductorDisponible) return; // no pintamos nada si esta en "no disponible"

  if (viajes.length === 0) {
    driverPendingList.innerHTML = '<div class="result-empty">No hay viajes pendientes por ahora</div>';
    return;
  }

  driverPendingList.innerHTML = viajes.map((v) => {
    const paradasViaje = paradasPorViaje[v.id] || [];
    const destinoTexto = paradasViaje.length === 0
      ? (v.destino_direccion || 'Destino sin especificar')
      : paradasViaje.length === 1
        ? (paradasViaje[0].direccion || 'Destino')
        : `${paradasViaje.length} paradas`;
    const origenTexto = v.origen_direccion || 'Origen sin especificar';
    const precioTexto = v.precio ? `$ ${Number(v.precio).toLocaleString('es-AR')}` : '$ —';

    return `
      <div class="driver-pending-card" data-id="${v.id}">
        <div class="driver-pending-ruta">
          <span class="punto">Desde:</span> ${origenTexto}<br>
          <span class="punto">Hasta:</span> ${destinoTexto}
        </div>
        <div class="driver-pending-meta">
          <span class="driver-pending-precio">${precioTexto}</span>
          <span class="driver-pending-tiempo">${textoHaceCuanto(v.creado_en)}</span>
        </div>
        <button class="driver-pending-aceptar" data-id="${v.id}">Aceptar</button>
      </div>
    `;
  }).join('');

  driverPendingList.querySelectorAll('.driver-pending-aceptar').forEach((btn) => {
    btn.addEventListener('click', () => aceptarViaje(btn.dataset.id, btn));
  });
}

function iniciarListaPendientes() {
  detenerListaPendientes();
  refrescarListaPendientes();

  canalPendientesConductor = supabase
    .channel('conductor-viajes-pendientes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'viajes', filter: 'estado=eq.pendiente' },
      () => refrescarListaPendientes(),
    )
    .subscribe();
}

function detenerListaPendientes() {
  if (canalPendientesConductor) {
    supabase.removeChannel(canalPendientesConductor);
    canalPendientesConductor = null;
  }
}

// ---- Toggle "Disponible para viajes" ----
toggleDisponible.addEventListener('click', async () => {
  if (!conductorTelefonoActual) return;

  conductorDisponible = !conductorDisponible;
  actualizarToggleUI();

  const { error } = await supabase
    .from('conductores')
    .update({ disponible: conductorDisponible })
    .eq('telefono', conductorTelefonoActual);

  if (error) {
    console.error('[Movi] Error actualizando disponibilidad:', error);
  }

  if (conductorDisponible) {
    iniciarListaPendientes();
  } else {
    detenerListaPendientes();
    driverPendingList.innerHTML = '';
  }
});

// ---- FASE 3: aceptar un viaje (con proteccion contra doble asignacion) ----
async function aceptarViaje(viajeId, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = 'Aceptando...';

  const { data: conductorRow } = await supabase
    .from('conductores')
    .select('*')
    .eq('telefono', conductorTelefonoActual)
    .maybeSingle();

  const { data, error } = await supabase
    .from('viajes')
    .update({
      estado: 'conductor_asignado',
      conductor_telefono: conductorTelefonoActual,
      nombre_conductor: conductorRow?.nombre || 'Conductor',
      patente_conductor: conductorRow?.patente || null,
      modelo_auto_conductor: conductorRow?.modelo_auto || null,
      color_auto_conductor: conductorRow?.color_auto || null,
      eta_minutos: 3,
    })
    .eq('id', viajeId)
    .is('conductor_telefono', null) // <- evita que dos conductores tomen el mismo viaje a la vez
    .select()
    .single();

  if (error || !data) {
    // No afecto ninguna fila: alguien mas lo acepto primero.
    btnEl.textContent = 'Ya fue tomado';
    setTimeout(() => refrescarListaPendientes(), 800);
    return;
  }

  detenerListaPendientes();
  conductorDisponible = false;
  actualizarToggleUI();

  await supabase.from('conductores').update({ disponible: false }).eq('telefono', conductorTelefonoActual);

  // evaluarViajeConductor (suscripcion ya activa desde iniciarSupervisionViajeConductor)
  // va a detectar este viaje nuevo y disparar entrarAVistaViajeActiva() sola.
}

// ---- FASE 4: vista del conductor durante el viaje activo ----
async function entrarAVistaViajeActiva(viaje) {
  conductorViajeActivo = viaje;
  mostrarOverlay(null);
  driverWaitingOverlay.classList.remove('show');
  sheet.style.display = 'none'; // el sheet de pasajero no debe verse detras en sesion de conductor
  driverActiveSheet.style.display = 'block';

  const auto = [viaje.modelo_auto_conductor, viaje.color_auto_conductor].filter(Boolean).join(' · ');
  driverActiveInfo.innerHTML = `
    <strong>Origen:</strong> ${viaje.origen_direccion || 'sin especificar'}<br>
    ${auto ? `<strong>Tu auto:</strong> ${auto}<br>` : ''}
    <strong>Precio:</strong> ${viaje.precio ? `$ ${Number(viaje.precio).toLocaleString('es-AR')}` : '—'}
  `;

  actualizarBotonesViajeActivo(viaje.estado);

  // Ruta desde la posicion actual del conductor hasta el origen del pasajero.
  if (viaje.origen_lat != null && viaje.origen_lng != null) {
    await dibujarRutaConductorHaciaOrigen(viaje);
  }
}

function actualizarBotonesViajeActivo(estado) {
  btnConductorLlegue.style.display = estado === 'conductor_asignado' ? 'block' : 'none';
  btnConductorIniciar.style.display = estado === 'llegó' ? 'block' : 'none';
  btnConductorFinalizar.style.display = estado === 'en_viaje' ? 'block' : 'none';

  driverActiveTitulo.textContent =
    estado === 'conductor_asignado' ? 'Yendo a buscar al pasajero'
    : estado === 'llegó' ? 'Esperando al pasajero'
    : estado === 'en_viaje' ? 'Viaje en curso'
    : 'Viaje';
}

async function obtenerPosicionActualConductor() {
  if (!('geolocation' in navigator)) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}

async function dibujarRutaConductorHaciaOrigen(viaje) {
  const posActual = await obtenerPosicionActualConductor();
  if (!posActual) return;

  const destino = { lat: viaje.origen_lat, lng: viaje.origen_lng };
  const ruta = await getRuta([posActual, destino]);
  if (!ruta || !map.getSource('ruta')) return;

  map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
  rutaGeometriaActual = ruta.geometry?.coordinates || null;
  window._iniciarAnimacionGlow?.();

  const bounds = new mapboxgl.LngLatBounds()
    .extend([posActual.lng, posActual.lat])
    .extend([destino.lng, destino.lat]);
  map.fitBounds(bounds, { padding: 80 });
}

async function dibujarRutaConductorViajeCompleto(viaje) {
  const { data: paradasViaje } = await supabase
    .from('paradas')
    .select('*')
    .eq('viaje_id', viaje.id)
    .order('orden', { ascending: true });

  if (!paradasViaje || paradasViaje.length === 0) return;

  const origen = { lat: viaje.origen_lat, lng: viaje.origen_lng };
  const puntos = [origen, ...paradasViaje.map((p) => ({ lat: p.lat, lng: p.lng }))];
  const ruta = await getRuta(puntos);
  if (!ruta || !map.getSource('ruta')) return;

  map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
  rutaGeometriaActual = ruta.geometry?.coordinates || null;
  window._iniciarAnimacionGlow?.();

  const bounds = new mapboxgl.LngLatBounds();
  puntos.forEach((p) => bounds.extend([p.lng, p.lat]));
  map.fitBounds(bounds, { padding: 80 });
}

btnConductorLlegue.addEventListener('click', async () => {
  if (!conductorViajeActivo) return;
  btnConductorLlegue.disabled = true;
  const { error } = await supabase
    .from('viajes')
    .update({ estado: 'llegó' })
    .eq('id', conductorViajeActivo.id);
  btnConductorLlegue.disabled = false;
  if (error) console.error('[Movi] Error marcando "llegué":', error);
  // La actualizacion de UI la dispara evaluarViajeConductor via Realtime.
});

btnConductorIniciar.addEventListener('click', async () => {
  if (!conductorViajeActivo) return;
  btnConductorIniciar.disabled = true;
  const { error } = await supabase
    .from('viajes')
    .update({ estado: 'en_viaje' })
    .eq('id', conductorViajeActivo.id);
  btnConductorIniciar.disabled = false;
  if (error) console.error('[Movi] Error iniciando viaje:', error);
});

btnConductorFinalizar.addEventListener('click', async () => {
  if (!conductorViajeActivo) return;
  btnConductorFinalizar.disabled = true;
  const { error } = await supabase
    .from('viajes')
    .update({ estado: 'finalizado' })
    .eq('id', conductorViajeActivo.id);
  btnConductorFinalizar.disabled = false;
  if (error) console.error('[Movi] Error finalizando viaje:', error);
});

// ---- FASE 5: al terminar/cancelarse, volver a la lista de pendientes ----
async function salirDeVistaViajeActiva() {
  conductorViajeActivo = null;
  driverActiveSheet.style.display = 'none';
  sheet.style.display = ''; // deja que la hoja de pasajero vuelva a su estado normal por si se cambia de rol

  if (map.getSource('ruta')) {
    map.getSource('ruta').setData({ type: 'FeatureCollection', features: [] });
  }
  rutaGeometriaActual = null;

  if (conductorTelefonoActual) {
    await supabase.from('conductores').update({ disponible: true }).eq('telefono', conductorTelefonoActual);
  }
  conductorDisponible = true;
  actualizarToggleUI();

  mostrarOverlay(driverWaitingOverlay);
  iniciarListaPendientes();
}

function evaluarViajeConductor(viaje, telefono) {
  const activo = viaje && !ESTADOS_VIAJE_INACTIVO_CONDUCTOR.includes(viaje.estado);

  if (activo) {
    iniciarTrackingConductor(telefono);

    if (!conductorViajeActivo || conductorViajeActivo.id !== viaje.id) {
      entrarAVistaViajeActiva(viaje);
    } else {
      const estadoPrevio = conductorViajeActivo.estado;
      conductorViajeActivo = viaje;
      actualizarBotonesViajeActivo(viaje.estado);
      if (viaje.estado === 'en_viaje' && estadoPrevio !== 'en_viaje') {
        dibujarRutaConductorViajeCompleto(viaje);
      }
    }
  } else {
    detenerTrackingConductor();
    if (conductorViajeActivo) {
      salirDeVistaViajeActiva();
    }
  }
}

// Prende (o apaga) el tracking segun haya o no un viaje en curso para
// este conductor, y se queda escuchando cambios en tiempo real para
// reaccionar apenas se le asigna un viaje o el viaje termina/se cancela.
// Tambien deja lista la sesion del conductor: quien es (conductorTelefonoActual),
// su disponibilidad real (leida de Supabase, no asumida en false), y si hay
// o no un viaje activo ya asignado desde antes (por si recargo la pagina).
function iniciarSupervisionViajeConductor(telefono) {
  conductorTelefonoActual = telefono;

  if (canalViajeConductor) {
    supabase.removeChannel(canalViajeConductor);
    canalViajeConductor = null;
  }

  // Disponibilidad real guardada en Supabase (si el conductor recarga la
  // pagina, no queremos que la UI vuelva a "no disponible" por defecto).
  supabase
    .from('conductores')
    .select('disponible')
    .eq('telefono', telefono)
    .maybeSingle()
    .then(({ data }) => {
      conductorDisponible = Boolean(data?.disponible);
      actualizarToggleUI();
      if (conductorDisponible && !conductorViajeActivo) {
        iniciarListaPendientes();
      }
    });

  // Estado inicial: por si el conductor recarga la app en medio de un viaje.
  supabase
    .from('viajes')
    .select('*')
    .eq('conductor_telefono', telefono)
    .not('estado', 'in', '(pendiente,finalizado,cancelado)')
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) {
        console.error('[Movi] Error buscando viaje activo del conductor:', error);
        return;
      }
      evaluarViajeConductor(data, telefono);
    });

  canalViajeConductor = supabase
    .channel(`conductor-viaje-activo-${telefono}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'viajes', filter: `conductor_telefono=eq.${telefono}` },
      (payload) => evaluarViajeConductor(payload.new, telefono),
    )
    .subscribe();
}

const VIEDMA_CENTER = [-62.9961, -40.8125];

// Chequeo de conexion a Supabase (por ahora solo console.log, todavia no
// reemplaza los resultados de ejemplo del buscador). Se filtra por una
// zona alrededor del centro de Viedma en vez de traer todas las filas.
getLugares({ lat: VIEDMA_CENTER[1], lng: VIEDMA_CENTER[0], radioMetros: 5000 }).then((lugares) => {
  console.log('[Movi] Lugares traidos de Supabase:', lugares.length);
});

mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: VIEDMA_CENTER,
  zoom: 14,
});

map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');

// ==================================================================
//  Capa de la linea de ruta (se llena/actualiza en recalcularRuta()).
// ==================================================================
map.on('load', () => {
  map.addSource('ruta', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // 1. CAPA ABAJO: ruta-glow - blanco con blur suave (glow)
  map.addLayer({
    id: 'ruta-glow',
    type: 'line',
    source: 'ruta',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        12, 10,
        16, 22,
        19, 32,
      ],
      'line-blur': 8,
      'line-opacity': 1,
    },
  });

  // 2. CAPA ARRIBA: ruta-linea - verde (#1F8A4C), ancho proporcional al zoom, sin blur
  map.addLayer({
    id: 'ruta-linea',
    type: 'line',
    source: 'ruta',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#1F8A4C',
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        12, 3,
        16, 6,
        19, 10,
      ],
    },
  });

  // ==================================================================
  //  Icono del auto del conductor: capa "symbol" (no un mapboxgl.Marker
  //  HTML) para que se pueda alinear al plano del mapa en 3D (rotacion +
  //  inclinacion siguen el heading real y el pitch del mapa). Se alimenta
  //  de la posicion real del conductor asignado via Supabase Realtime
  //  (ver iniciarSeguimientoPosicionConductor mas abajo). Arranca vacio:
  //  solo se llena cuando hay un viaje activo con conductor.
  // ==================================================================
  map.loadImage('/icons/auto-top.png', (error, image) => {
    if (error) {
      console.error('[Movi] Error cargando icono del auto:', error);
      return;
    }
    map.addImage('auto-conductor', image);

    map.addSource('auto-conductor', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: 'auto-conductor',
      type: 'symbol',
      source: 'auto-conductor',
      layout: {
        'icon-image': 'auto-conductor',
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.035, 16, 0.07, 19, 0.1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  });

  // ==================================================================
  //  Animación del glow de la ruta: parpadeo suave con onda senoidal.
  //  Mientras la fuente "ruta" tenga features, oscila la opacidad de
  //  "ruta-glow" entre 0.4 y 1.0 (ciclo ~2 s). Se pausa automáticamente
  //  cuando no hay ruta dibujada.
  // ==================================================================
  let animacionGlowFrameId = null;

  function tickGlow() {
    const source = map.getSource('ruta');
    if (!source) { animacionGlowFrameId = null; return; }

    const data = source._data;
    const tieneRuta = data && (
      (data.type === 'FeatureCollection' && data.features && data.features.length > 0) ||
      (data.type === 'Feature' && data.geometry)
    );

    if (!tieneRuta) {
      // No hay ruta dibujada → pausamos para no gastar batería
      animacionGlowFrameId = null;
      return;
    }

    const duracion = 2000; // 2 s por ciclo completo
    const now = performance.now();
    const elapsed = (now % duracion) / duracion; // 0 → 1
    const phase = elapsed * Math.PI * 2;          // 0 → 2π
    // Seno centrado en 0.775 con amplitud 0.225 → oscila entre 0.55 y 1.0
    const opacity = 0.775 + 0.225 * Math.sin(phase);

    map.setPaintProperty('ruta-glow', 'line-opacity', opacity);
    animacionGlowFrameId = requestAnimationFrame(tickGlow);
  }

  window._iniciarAnimacionGlow = function () {
    if (animacionGlowFrameId !== null) return; // ya está corriendo
    animacionGlowFrameId = requestAnimationFrame(tickGlow);
  };
});

// ==================================================================
//  Posicion en vivo del auto del conductor asignado: se prende/apaga
//  segun el estado del viaje activo del pasajero (ver
//  sincronizarCapaAutoConductor, llamada desde los 5 puntos donde cambia
//  viajeActivoPasajero mas abajo), y se alimenta de UPDATE en tiempo real
//  de la tabla "conductores" (mismo patron que iniciarSupervisionViajeConductor,
//  del lado conductor, que escucha "viajes").
// ==================================================================
let canalPosicionConductor = null;
let telefonoConductorSeguido = null;

const ESTADOS_VIAJE_CON_AUTO_VISIBLE = ['conductor_asignado', 'en_camino', 'en_viaje'];

// Punto central: decide si el auto del conductor debe estar visible en el
// mapa segun el viaje activo del pasajero. Llamar siempre despues de
// cualquier cambio a viajeActivoPasajero.
function sincronizarCapaAutoConductor() {
  const telefono = viajeActivoPasajero?.conductor_telefono;
  const activo = Boolean(telefono) && ESTADOS_VIAJE_CON_AUTO_VISIBLE.includes(viajeActivoPasajero.estado);

  if (activo) {
    iniciarSeguimientoPosicionConductor(telefono);
  } else {
    detenerSeguimientoPosicionConductor();
  }
}

// ==================================================================
//  FIX: el auto se movía directo a las coordenadas crudas del GPS del
//  conductor, sin relación con la ruta dibujada — por eso se veía
//  "flotando" lejos de la calle y no se acercaba prolijamente al pin
//  de origen (el margen de error normal del GPS, unos 5-15m en
//  ciudad, alcanza para caer en la vereda de al lado o en un techo).
//  Se agrega una proyección sobre la geometría real de la ruta
//  (rutaGeometriaActual), asi el icono queda siempre "pegado" a la
//  calle, mas una animacion suave entre fixes (antes saltaba de
//  golpe cada vez que llegaba una actualizacion).
// ==================================================================
const METROS_POR_GRADO_LAT_AUTO = 111320;

// Proyecta un punto {lat,lng} sobre el segmento a-b (ambos [lng,lat]) y
// devuelve el punto mas cercano de ese segmento + que tan lejos quedo (en
// metros, aproximado) + el rumbo del segmento en si (direccion de la calle
// en ese tramo). Aproximacion plana con correccion de longitud por
// latitud: de sobra de precision a escala de una ciudad como Viedma.
function proyectarEnSegmento(lat, lng, a, b) {
  const latRef = a[1] * Math.PI / 180;
  const metrosPorGradoLng = METROS_POR_GRADO_LAT_AUTO * Math.cos(latRef);

  const px = lng * metrosPorGradoLng;
  const py = lat * METROS_POR_GRADO_LAT_AUTO;
  const ax = a[0] * metrosPorGradoLng;
  const ay = a[1] * METROS_POR_GRADO_LAT_AUTO;
  const bx = b[0] * metrosPorGradoLng;
  const by = b[1] * METROS_POR_GRADO_LAT_AUTO;

  const dx = bx - ax;
  const dy = by - ay;
  const largo2 = dx * dx + dy * dy;

  let t = largo2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / largo2;
  t = Math.max(0, Math.min(1, t));

  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const distanciaMetros = Math.hypot(px - projX, py - projY);

  const lngProj = projX / metrosPorGradoLng;
  const latProj = projY / METROS_POR_GRADO_LAT_AUTO;
  const rumboSegmento = calcularRumbo({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });

  return { lat: latProj, lng: lngProj, distanciaMetros, rumboSegmento };
}

// Recorre toda la geometria de la ruta y devuelve el punto mas cercano al
// fix crudo del GPS. Si el conductor se desvio mucho de la ruta calculada
// (>60m, por ejemplo tomo otro camino), se devuelve el fix crudo tal cual
// en vez de "pegarlo" a una calle que ya no esta siguiendo.
function proyectarEnRuta(lat, lng, coordenadas) {
  if (!coordenadas || coordenadas.length < 2) return null;

  let mejor = null;
  for (let i = 0; i < coordenadas.length - 1; i++) {
    const candidato = proyectarEnSegmento(lat, lng, coordenadas[i], coordenadas[i + 1]);
    if (!mejor || candidato.distanciaMetros < mejor.distanciaMetros) {
      mejor = candidato;
    }
  }

  if (!mejor || mejor.distanciaMetros > 60) return null;
  return mejor;
}

// Angulo mas corto entre dos rumbos (0-360), para que la rotacion del
// icono nunca "de la vuelta larga" (ej: de 350° a 10° debe animar +20°,
// no -340°).
function interpolarAngulo(desde, hasta, t) {
  let diferencia = ((hasta - desde + 540) % 360) - 180;
  return (desde + diferencia * t + 360) % 360;
}

let animacionAutoFrameId = null;
let posicionAutoMostrada = null; // ultima posicion realmente pintada en el mapa

function pintarAutoEnMapa(lat, lng, heading) {
  const source = map.getSource('auto-conductor');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { heading },
    }],
  });
  posicionConductor = { lat, lng, heading };
}

// Anima el icono del auto desde su posicion actual en pantalla hasta la
// nueva posicion objetivo, en vez de saltar de golpe. La duracion (2.2s)
// queda un poco por debajo del intervalo tipico entre fixes de GPS (3s)
// para que la animacion siempre termine antes de que llegue el proximo.
function animarAutoHacia(latDestino, lngDestino, headingDestino) {
  if (animacionAutoFrameId !== null) {
    cancelAnimationFrame(animacionAutoFrameId);
    animacionAutoFrameId = null;
  }

  const desde = posicionAutoMostrada || { lat: latDestino, lng: lngDestino, heading: headingDestino };
  const duracion = 2200;
  const inicio = performance.now();

  function tick(ahora) {
    const t = Math.min(1, (ahora - inicio) / duracion);
    const lat = desde.lat + (latDestino - desde.lat) * t;
    const lng = desde.lng + (lngDestino - desde.lng) * t;
    const heading = interpolarAngulo(desde.heading, headingDestino, t);

    pintarAutoEnMapa(lat, lng, heading);

    if (t < 1) {
      animacionAutoFrameId = requestAnimationFrame(tick);
    } else {
      animacionAutoFrameId = null;
      posicionAutoMostrada = { lat: latDestino, lng: lngDestino, heading: headingDestino };
    }
  }

  animacionAutoFrameId = requestAnimationFrame(tick);
}

function aplicarNuevaPosicionConductor(fix) {
  if (!fix || fix.lat == null || fix.lng == null) return;

  const proyeccion = rutaGeometriaActual
    ? proyectarEnRuta(fix.lat, fix.lng, rutaGeometriaActual)
    : null;

  // Preferimos la posicion "enganchada" a la calle; si el conductor se
  // desvio de la ruta calculada (o todavia no hay ruta dibujada), usamos
  // el punto crudo del GPS tal cual, para no perder la posicion real.
  const latObjetivo = proyeccion ? proyeccion.lat : fix.lat;
  const lngObjetivo = proyeccion ? proyeccion.lng : fix.lng;

  // Para la rotacion: el heading del dispositivo es mas confiable cuando
  // viene (indica hacia donde apunta el telefono/auto de verdad), pero si
  // no vino (comun a baja velocidad) usamos el rumbo de la calle en ese
  // tramo de la ruta como mejor aproximacion disponible.
  let headingObjetivo = fix.heading;
  if (headingObjetivo == null || Number.isNaN(headingObjetivo)) {
    headingObjetivo = proyeccion ? proyeccion.rumboSegmento : 0;
  }

  animarAutoHacia(latObjetivo, lngObjetivo, headingObjetivo);
}

function iniciarSeguimientoPosicionConductor(telefono) {
  if (telefonoConductorSeguido === telefono && canalPosicionConductor) return; // ya esta corriendo

  detenerSeguimientoPosicionConductor(); // por si veniamos siguiendo a otro conductor
  telefonoConductorSeguido = telefono;

  // Estado inicial: por si el pasajero recarga la app en medio de un viaje
  // con conductor ya asignado (mismo patron que iniciarSupervisionViajeConductor).
  supabase
    .from('conductores')
    .select('lat, lng, heading')
    .eq('telefono', telefono)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) {
        console.error('[Movi] Error obteniendo posicion inicial del conductor:', error);
        return;
      }
      aplicarNuevaPosicionConductor(data);
    });

  canalPosicionConductor = supabase
    .channel(`pasajero-posicion-conductor-${telefono}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'conductores', filter: `telefono=eq.${telefono}` },
      (payload) => aplicarNuevaPosicionConductor(payload.new),
    )
    .subscribe();
}

function detenerSeguimientoPosicionConductor() {
  if (canalPosicionConductor) {
    supabase.removeChannel(canalPosicionConductor);
    canalPosicionConductor = null;
  }
  telefonoConductorSeguido = null;
  posicionConductor = null;

  if (animacionAutoFrameId !== null) {
    cancelAnimationFrame(animacionAutoFrameId);
    animacionAutoFrameId = null;
  }
  posicionAutoMostrada = null;
  rutaGeometriaActual = null;

  const source = map.getSource('auto-conductor');
  if (source) source.setData({ type: 'FeatureCollection', features: [] });
}

// ==================================================================
//  Pin de origen: ubicacion real del usuario (arrastrable) y pin de
//  destino (se reemplaza cada vez que se elige un resultado nuevo).
// ==================================================================
let origenActual = { lat: VIEDMA_CENTER[1], lng: VIEDMA_CENTER[0] };
let ubicacionReal = { lat: VIEDMA_CENTER[1], lng: VIEDMA_CENTER[0] };
let marcadoresParadas = []; // un mapboxgl.Marker numerado por cada parada, en orden

const origenEl = document.createElement('div');
origenEl.className = 'origen-marker';

const marcadorOrigen = new mapboxgl.Marker({ element: origenEl, draggable: true })
  .setLngLat([origenActual.lng, origenActual.lat])
  .addTo(map);

// ==================================================================
//  Aviso de seguridad: si el usuario arrastra el pin de origen, hay
//  que confirmarlo antes de poder pedir el viaje (no se puede ignorar
//  facil, bloquea el CTA hasta que se confirme o se vuelva al GPS real).
// ==================================================================

// Sin destino elegido todavia no se puede pedir viaje.
btnPedirViaje.disabled = true;

function mostrarAvisoOrigen() {
  origenToast.classList.add('show');
  btnPedirViaje.disabled = true;
}

function ocultarAvisoOrigen() {
  origenToast.classList.remove('show');
  btnPedirViaje.disabled = !destinoActual;
}

marcadorOrigen.on('dragend', () => {
  const { lng, lat } = marcadorOrigen.getLngLat();
  origenActual = { lat, lng };
  mostrarAvisoOrigen();
  recalcularRuta();
});

btnConfirmarOrigen.addEventListener('click', () => {
  ocultarAvisoOrigen();
});

btnVolverUbicacion.addEventListener('click', () => {
  origenActual = { ...ubicacionReal };
  marcadorOrigen.setLngLat([origenActual.lng, origenActual.lat]);
  map.setCenter([origenActual.lng, origenActual.lat]);
  ocultarAvisoOrigen();
  recalcularRuta();
});

if ('geolocation' in navigator) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      ubicacionReal = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      origenActual = { ...ubicacionReal };
      marcadorOrigen.setLngLat([origenActual.lng, origenActual.lat]);
      map.setCenter([origenActual.lng, origenActual.lat]);
    },
    () => {
      // Sin permiso o error: nos quedamos con el centro de Viedma, sin romper nada.
    },
  );
}

// ==================================================================
//  Paradas: lista ordenada donde la ultima es siempre el destino final.
// ==================================================================
function recalcularOrdenes() {
  paradas.forEach((p, i) => { p.orden = i + 1; });
}

function sincronizarDestinoActual() {
  const destinoFinal = paradas.length ? paradas[paradas.length - 1] : null;
  destinoActual = destinoFinal ? { lat: destinoFinal.lat, lng: destinoFinal.lng } : null;
  btnPedirViaje.disabled = !destinoActual;
  btnModificarDestino.disabled = !destinoActual;
  btnVerParadas.disabled = paradas.length === 0;
  paradasCount.textContent = String(paradas.length);
}

function ajustarMapaAParadas() {
  if (paradas.length === 0) return;
  const bounds = new mapboxgl.LngLatBounds().extend([origenActual.lng, origenActual.lat]);
  paradas.forEach((p) => bounds.extend([p.lng, p.lat]));
  map.fitBounds(bounds, { padding: 80 });
}

// Un pin numerado por cada parada (1, 2, 3...) segun su orden. Si solo hay
// una parada (caso mas comun, un unico destino) se muestra igual el "1"
// para mantener consistencia. La ultima parada (destino final) se destaca
// en verde; las intermedias en negro. Se recrean todos en cada cambio: son
// pocos elementos y asi evitamos desincronizar numero <-> posicion.
function actualizarMarcadoresParadas() {
  marcadoresParadas.forEach((m) => m.remove());
  marcadoresParadas = [];

  paradas.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'parada-marker';
    if (i === paradas.length - 1) el.classList.add('parada-marker-final');
    el.textContent = String(p.orden);

    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([p.lng, p.lat])
      .addTo(map);

    marcadoresParadas.push(marker);
  });
}

function despuesDeCambiarParadas() {
  sincronizarDestinoActual();
  actualizarMarcadoresParadas();
  ajustarMapaAParadas();
  if (paradasOverlay.classList.contains('show')) renderParadasPanel();
  recalcularRuta();
}

function agregarParada(item) {
  paradas.push({ ...item, orden: paradas.length + 1 });
  despuesDeCambiarParadas();
}

function reemplazarDestinoFinal(item) {
  if (paradas.length === 0) {
    paradas.push({ ...item, orden: 1 });
  } else {
    paradas[paradas.length - 1] = { ...paradas[paradas.length - 1], ...item, orden: paradas.length };
  }
  despuesDeCambiarParadas();
}

function eliminarParada(index) {
  // Siempre debe quedar al menos un destino final.
  if (paradas.length <= 1) return;
  paradas.splice(index, 1);
  recalcularOrdenes();
  despuesDeCambiarParadas();
}

function renderParadasPanel() {
  if (paradas.length === 0) {
    paradasPanelList.innerHTML = '<div class="result-empty">Todavía no agregaste paradas</div>';
    return;
  }

  paradasPanelList.innerHTML = paradas.map((p, i) => `
    <div class="parada-row">
      <div class="parada-row-numero">${p.orden}</div>
      <div class="parada-row-direccion">${p.direccion || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}</div>
      <button class="parada-row-eliminar" data-index="${i}" ${paradas.length <= 1 ? 'disabled' : ''} aria-label="Eliminar parada">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  `).join('');

  paradasPanelList.querySelectorAll('.parada-row-eliminar').forEach((btn) => {
    btn.addEventListener('click', () => eliminarParada(Number(btn.dataset.index)));
  });
}

// Punto de entrada unico para cualquier direccion elegida (busqueda o toque
// en el mapa): segun modoBusqueda, agrega una parada nueva o reemplaza el
// destino final. Despues de procesar, vuelve siempre al modo por defecto.
function mostrarDestino(lat, lng, direccion) {
  const item = { lat, lng, direccion: direccion || '' };

  // Aprendizaje de lugares: no bloquea el flujo, solo suma un voto si el
  // punto es un POI con nombre real (ver registrarSeleccionDeLugar).
  registrarSeleccionDeLugar(lat, lng);

  if (modoBusqueda === 'agregar-parada') {
    agregarParada(item);
  } else {
    reemplazarDestinoFinal(item);
  }
  modoBusqueda = null;
}

// ==================================================================
//  Ruta + precio real (Mapbox Directions). Se recalcula cada vez que
//  se mueve el origen (dragend) o cambia la lista de paradas. Pasa por
//  el origen y todas las paradas en orden, asi que la distancia/duracion
//  (y por lo tanto el precio) ya reflejan el recorrido completo.
//  Formula: 2000 + (km * 200) + (minutos * 80), redondeado al peso.
// ==================================================================
async function recalcularRuta() {
  if (!destinoActual || paradas.length === 0) return;

  const puntos = [origenActual, ...paradas.map((p) => ({ lat: p.lat, lng: p.lng }))];
  const ruta = await getRuta(puntos);
  if (!ruta) return;

  const minutosTexto = Math.round(ruta.minutos);
  document.getElementById('ride-sub-normal').textContent = `${minutosTexto} min · ${ruta.km.toFixed(1)} km`;

  const precio = Math.round(2000 + ruta.km * 200 + ruta.minutos * 80);
  document.getElementById('ride-price-normal').textContent = `$ ${precio.toLocaleString('es-AR')}`;

  if (map.getSource('ruta')) {
    map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
  }
  rutaGeometriaActual = ruta.geometry?.coordinates || null;

  // Iniciar (o reanudar) la animación del glow ahora que hay ruta
  window._iniciarAnimacionGlow();
}

// ==================================================================
//  Sheet de busqueda: resultados reales de Mapbox Geocoding (ver
//  js/apiservices.js), con debounce para no llamar a la API en cada tecla.
// ==================================================================
let resultadosActuales = [];

// Combina lugares de Supabase (comercios locales que Mapbox no indexa bien
// en esta zona) con resultados de Mapbox Geocoding. Los de Supabase van
// primero (mas confiables para Viedma/Patagones); se descartan duplicados
// por cercania real (<=30m) y se recorta a 3 resultados en total.
async function buscarDestinos(query) {
  const [lugaresSupabase, resultadosMapbox] = await Promise.all([
    searchLugares(query),
    searchMapbox(query),
  ]);

  const combinados = lugaresSupabase.map((l) => ({
    nombre: l.name || l.direccion || l.address || 'Lugar guardado',
    direccion: l.address || l.direccion || '',
    lat: l.lat,
    lng: l.lng,
  }));

  resultadosMapbox.forEach((r) => {
    const esDuplicado = combinados.some((c) => distanciaMetros(c.lat, c.lng, r.lat, r.lng) <= 30);
    if (!esDuplicado) combinados.push(r);
  });

  return combinados.slice(0, 3);
}

function renderResultados(resultados) {
  resultadosActuales = resultados;

  if (resultados.length === 0) {
    resultsList.innerHTML = '<div class="result-empty">Sin resultados</div>';
    return;
  }

  resultsList.innerHTML = resultados.slice(0, 3).map((r, i) => `
    <div class="result-item" data-index="${i}">
      <div class="result-pin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>
      </div>
      <div>
        <div class="result-name">${r.nombre}</div>
        <div class="result-address">${r.direccion}</div>
      </div>
    </div>
  `).join('');

  resultsList.querySelectorAll('.result-item').forEach((el) => {
    el.addEventListener('click', () => {
      const r = resultadosActuales[el.dataset.index];
      searchInput.value = r.nombre;
      ocultarResultados();
      mostrarDestino(r.lat, r.lng, r.direccion || r.nombre);
    });
  });
}

function ocultarResultados() {
  resultsList.classList.remove('show');
  resultsLabel.style.display = 'none';
  resultsList.innerHTML = '';
  resultadosActuales = [];
}

let searchTimeoutId = null;

searchInput.addEventListener('input', (e) => {
  const query = e.target.value.trim();

  if (searchTimeoutId) clearTimeout(searchTimeoutId);

  if (!query) {
    ocultarResultados();
    return;
  }

  resultsList.classList.add('show');
  resultsLabel.style.display = 'block';

  searchTimeoutId = setTimeout(async () => {
    const resultados = await buscarDestinos(query);
    // Si el usuario ya cambio el texto mientras esperabamos la respuesta,
    // no pisamos su busqueda mas nueva con datos viejos.
    if (searchInput.value.trim() !== query) return;
    renderResultados(resultados);
  }, 400);
});

// ==================================================================
//  Tocar el mapa directamente tambien elige destino: reverse geocoding
//  del punto tocado, tratado igual que elegir un resultado de busqueda.
// ==================================================================
map.on('click', async (e) => {
  const { lng, lat } = e.lngLat;

  // Modo dev "mover auto": si esta activo, tocar el mapa teleporta al
  // conductor en vez de elegir un destino (ver panel de desarrollador).
  if (devModoMoverAuto) {
    devMoverAutoA(lat, lng);
    return;
  }

  ocultarResultados();

  const direccion = await reverseGeocode(lat, lng);
  searchInput.value = direccion || `Ubicacion ${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  mostrarDestino(lat, lng, searchInput.value);
});

// ==================================================================
//  Boton flotante "centrar mapa": segun el momento del viaje, centra
//  la camara con una animacion suave en distinto lugar.
//    - Sin viaje activo / estado "pendiente": centra en el origen.
//    - "conductor_asignado" / "en_camino": centra en el auto del
//      conductor (posicionConductor). Todavia no existe una fuente real
//      para esa posicion (se arma en el paso del auto animado sobre la
//      ruta) asi que por ahora cae al origen como fallback.
//    - "en_viaje": encuadra la posicion actual del pasajero/auto junto
//      con el destino (fitBounds). Tampoco hay todavia una posicion en
//      tiempo real del pasajero durante el viaje; usamos origenActual
//      como mejor proxy disponible por ahora.
// ==================================================================
const btnCentrarMapa = document.getElementById('btn-centrar-mapa');

btnCentrarMapa.addEventListener('click', () => {
  // Reiniciar la animacion de pulso aunque se toque varias veces seguidas.
  btnCentrarMapa.classList.remove('pulse');
  void btnCentrarMapa.offsetWidth;
  btnCentrarMapa.classList.add('pulse');

  const estado = viajeActivoPasajero?.estado;

  if (estado === 'conductor_asignado' || estado === 'en_camino') {
    const objetivo = posicionConductor || origenActual;
    map.flyTo({ center: [objetivo.lng, objetivo.lat], zoom: 16, duration: 800 });
    return;
  }

  if (estado === 'en_viaje') {
    const posicionActual = posicionConductor || origenActual;
    if (destinoActual) {
      const bounds = new mapboxgl.LngLatBounds()
        .extend([posicionActual.lng, posicionActual.lat])
        .extend([destinoActual.lng, destinoActual.lat]);
      map.fitBounds(bounds, { padding: 80, duration: 800 });
    } else {
      map.flyTo({ center: [posicionActual.lng, posicionActual.lat], zoom: 16, duration: 800 });
    }
    return;
  }

  // Sin viaje activo o "pendiente": centrar en el origen del pasajero.
  map.flyTo({ center: [origenActual.lng, origenActual.lat], zoom: 16, duration: 800 });
});

// Tipos de viaje: seleccionar
document.querySelectorAll('.ride-row').forEach((row) => {
  row.addEventListener('click', () => {
    document.querySelectorAll('.ride-row').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
  });
});

// Guardados (por ahora solo placeholder, sin logica real)
// TODO: cuando exista login, leer aca la direccion guardada real del
// usuario (chip.dataset.place === 'casa' / 'trabajo') desde Supabase en
// vez de solo loguear el click.
document.querySelectorAll('.guardado-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    console.log('[Movi] Tocaste el guardado:', chip.dataset.place || 'agregar');
  });
});

// ==================================================================
//  Flujo: Pedir viaje -> Buscando conductor -> Conductor asignado
//  (con datos de ejemplo, sin Supabase conectado todavia)
// ==================================================================
const sheet = document.getElementById('sheet');
const buscandoOverlay = document.getElementById('buscando-overlay');
const driverSheet = document.getElementById('driver-sheet');
const paymentSheet = document.getElementById('payment-sheet');

// Canal Realtime que escucha un viaje puntual mientras el pasajero espera
// que algun conductor real lo acepte (ver btn-pedir-viaje). Se cierra apenas
// se asigna o se cancela, para no dejar suscripciones colgadas.
let canalEsperaAsignacion = null;

// Llena el driver-sheet con los datos reales del conductor que acepto el
// viaje (antes quedaba siempre con el texto de ejemplo "Leyvan Esquercia").
function aplicarDatosConductorEnSheet(viaje) {
  const nombre = viaje.nombre_conductor || 'Conductor';
  const auto = [viaje.modelo_auto_conductor, viaje.color_auto_conductor].filter(Boolean).join(' · ');

  document.querySelector('#driver-sheet .driver-avatar').textContent = nombre.charAt(0).toUpperCase();
  document.querySelector('#driver-sheet .driver-name').textContent = nombre;
  document.querySelector('#driver-sheet .driver-car').textContent = auto || 'Auto';

  if (viaje.eta_minutos != null) {
    const chips = document.querySelectorAll('#driver-sheet .eta-chip');
    if (chips[1]) chips[1].textContent = `${viaje.eta_minutos} min`;
  }
}

// ==================================================================
//  Botones de paradas: reutilizan el mismo buscador de direcciones,
//  la diferencia es que boton se toco antes de buscar (modoBusqueda).
// ==================================================================
function abrirBusquedaParaParada() {
  sheet.classList.remove('collapsed');
  searchInput.value = '';
  ocultarResultados();
  searchInput.focus();
}

btnAgregarParada.addEventListener('click', () => {
  modoBusqueda = 'agregar-parada';
  abrirBusquedaParaParada();
});

btnModificarDestino.addEventListener('click', () => {
  modoBusqueda = null;
  abrirBusquedaParaParada();
});

btnVerParadas.addEventListener('click', () => {
  renderParadasPanel();
  paradasOverlay.classList.add('show');
});

btnCerrarParadas.addEventListener('click', () => {
  paradasOverlay.classList.remove('show');
});

paradasOverlay.addEventListener('click', (e) => {
  if (e.target === paradasOverlay) paradasOverlay.classList.remove('show');
});

document.getElementById('btn-pedir-viaje').addEventListener('click', async () => {
  if (!destinoActual) return;

  console.log('[Movi] Iniciando guardado de viaje en Supabase...');

  buscandoOverlay.classList.add('show');

  const precioTexto = document.getElementById('ride-price-normal').textContent;
  const precio = Number(precioTexto.replace(/[^0-9]/g, '')) || null;

  const usuarioActual = cargarUsuario();
  const telefonoPasajero = usuarioActual ? usuarioActual.telefono : '';

  // FIX: el insert real no estaba guardando el origen (lat/lng/direccion) —
  // solo lo hacia la simulacion del panel de dev. Sin esto, la lista de
  // pendientes del conductor y el calculo de ruta hacia el origen (Fase 4)
  // no tendrian de donde sacar esos datos.
  const origenDireccion = await reverseGeocode(origenActual.lat, origenActual.lng)
    || `${origenActual.lat.toFixed(5)}, ${origenActual.lng.toFixed(5)}`;

  // FASE 3: ya no se asigna un conductor solo/al azar (buscarConductorDisponible
  // quedo sin uso mas abajo, solo la sigue llamando el panel de dev para sus
  // pruebas). El viaje queda en "pendiente" real y esperamos a que un
  // conductor de verdad lo acepte desde su propia pantalla.
  const { data: viaje, error } = await supabase
    .from('viajes')
    .insert({
      estado: 'pendiente',
      precio,
      telefono_pasajero: telefonoPasajero,
      origen_lat: origenActual.lat,
      origen_lng: origenActual.lng,
      origen_direccion: origenDireccion,
    })
    .select()
    .single();

  if (error) {
    console.error('[Movi] Error creando viaje en Supabase:', error);
    buscandoOverlay.classList.remove('show');
    return;
  }

  viajeActivoPasajero = viaje;
  sincronizarCapaAutoConductor();

  // Guardamos cada parada de la lista (incluido el destino final) en la
  // tabla "paradas", asociada al viaje recien creado.
  const { error: errorParadas } = await supabase
    .from('paradas')
    .insert(paradas.map((p) => ({
      viaje_id: viaje.id,
      orden: p.orden,
      direccion: p.direccion,
      lat: p.lat,
      lng: p.lng,
    })));

  if (errorParadas) {
    console.error('[Movi] Error guardando paradas en Supabase:', errorParadas);
  }

  // Nos quedamos escuchando este viaje puntual hasta que un conductor real
  // lo acepte (pasa a "conductor_asignado" con conductor_telefono cargado)
  // o hasta que se cancele desde otro lado.
  if (canalEsperaAsignacion) {
    supabase.removeChannel(canalEsperaAsignacion);
    canalEsperaAsignacion = null;
  }

  canalEsperaAsignacion = supabase
    .channel(`espera-asignacion-${viaje.id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'viajes', filter: `id=eq.${viaje.id}` },
      (payload) => {
        const actualizado = payload.new;
        viajeActivoPasajero = actualizado;

        if (actualizado.estado === 'conductor_asignado' && actualizado.conductor_telefono) {
          buscandoOverlay.classList.remove('show');
          sheet.style.display = 'none';
          driverSheet.style.display = 'block';
          aplicarDatosConductorEnSheet(actualizado);
          sincronizarCapaAutoConductor();

          if (canalEsperaAsignacion) {
            supabase.removeChannel(canalEsperaAsignacion);
            canalEsperaAsignacion = null;
          }
        } else if (actualizado.estado === 'cancelado') {
          buscandoOverlay.classList.remove('show');
          viajeActivoPasajero = null;
          sincronizarCapaAutoConductor();
          if (canalEsperaAsignacion) {
            supabase.removeChannel(canalEsperaAsignacion);
            canalEsperaAsignacion = null;
          }
        }
      },
    )
    .subscribe();
});

document.getElementById('btn-cancelar-busqueda').addEventListener('click', async () => {
  buscandoOverlay.classList.remove('show');

  if (canalEsperaAsignacion) {
    supabase.removeChannel(canalEsperaAsignacion);
    canalEsperaAsignacion = null;
  }

  // El viaje que estaba pendiente ya no debe seguir apareciendo en la
  // lista de los conductores.
  if (viajeActivoPasajero && viajeActivoPasajero.estado === 'pendiente') {
    await supabase.from('viajes').update({ estado: 'cancelado' }).eq('id', viajeActivoPasajero.id);
  }
  viajeActivoPasajero = null;
  sincronizarCapaAutoConductor();
});

document.getElementById('btn-cancelar-viaje').addEventListener('click', () => {
  driverSheet.style.display = 'none';
  sheet.style.display = 'block';
  viajeActivoPasajero = null;
  sincronizarCapaAutoConductor();
});

document.getElementById('btn-llamar').addEventListener('click', () => {
  console.log('[Movi] Llamando al conductor (todavia sin conectar)');
});

document.getElementById('btn-chatear').addEventListener('click', () => {
  console.log('[Movi] Abriendo chat con el conductor (todavia sin conectar)');
});

// ==================================================================
//  Arrastrar el sheet hacia abajo para minimizarlo, hacia arriba
//  para expandirlo. Generico: sirve para #sheet y #driver-sheet.
// ==================================================================
function hacerArrastrable(sheetEl) {
  const handle = sheetEl.querySelector('.sheet-handle-zone');
  if (!handle) return;

  let arrastrando = false;
  let startY = 0;
  let startTransform = 0;

  function getTranslateY() {
    const style = window.getComputedStyle(sheetEl);
    const matrix = style.transform;
    if (matrix === 'none') return 0;
    const values = matrix.match(/matrix.*\((.+)\)/)[1].split(', ');
    return parseFloat(values[5]) || 0;
  }

  handle.addEventListener('pointerdown', (e) => {
    arrastrando = true;
    startY = e.clientY;
    startTransform = getTranslateY();
    sheetEl.dataset.estabaColapsado = sheetEl.classList.contains('collapsed');
    sheetEl.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    const delta = e.clientY - startY;
    const nuevoY = Math.max(0, startTransform + delta);
    sheetEl.style.transform = `translateY(${nuevoY}px)`;
  });

  function terminarArrastre(e) {
    if (!arrastrando) return;
    arrastrando = false;
    sheetEl.classList.remove('dragging');
    const delta = e.clientY - startY;
    const estabaColapsado = sheetEl.dataset.estabaColapsado === 'true';

    if (estabaColapsado) {
      // Si estaba colapsado y arrastro mas de 40px hacia arriba, expande
      if (delta < -40) {
        sheetEl.classList.remove('collapsed');
      } else {
        sheetEl.classList.add('collapsed');
      }
    } else {
      // Si estaba expandido y arrastro mas de 60px hacia abajo, colapsa
      if (delta > 60) {
        sheetEl.classList.add('collapsed');
      } else {
        sheetEl.classList.remove('collapsed');
      }
    }
    sheetEl.style.transform = '';
  }

  handle.addEventListener('pointerup', terminarArrastre);
  handle.addEventListener('pointercancel', terminarArrastre);
}

hacerArrastrable(sheet);
hacerArrastrable(driverSheet);

// ==================================================================
//  Drawers: menu (izquierda) y perfil (derecha). Solo uno abierto
//  a la vez, se cierran con la X, el overlay, o eligiendo un item.
// ==================================================================
const drawerOverlay = document.getElementById('drawer-overlay');
const menuDrawer = document.getElementById('menu-drawer');
const perfilDrawer = document.getElementById('perfil-drawer');

function cerrarDrawers() {
  menuDrawer.classList.remove('show');
  perfilDrawer.classList.remove('show');
  drawerOverlay.classList.remove('show');
}

function abrirDrawer(drawerEl) {
  cerrarDrawers();
  drawerEl.classList.add('show');
  drawerOverlay.classList.add('show');
}

document.getElementById('btn-menu').addEventListener('click', () => abrirDrawer(menuDrawer));
document.getElementById('btn-perfil').addEventListener('click', () => abrirDrawer(perfilDrawer));
document.getElementById('btn-cerrar-menu').addEventListener('click', cerrarDrawers);
document.getElementById('btn-cerrar-perfil').addEventListener('click', cerrarDrawers);
drawerOverlay.addEventListener('click', cerrarDrawers);

// TODO: cuando exista login, leer aca la direccion guardada real del
// usuario para los items 'casa' / 'trabajo' del drawer de perfil, en vez
// de solo loguear el click.
document.querySelectorAll('.drawer-item, .drawer [data-item]').forEach((item) => {
  item.addEventListener('click', () => {
    const accion = item.dataset.item;
    console.log('[Movi] Tocaste el item del drawer:', accion);
    cerrarDrawers();

    if (accion === 'cerrar-sesion') {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem('rol');
      localStorage.removeItem('conductor_telefono');
      localStorage.removeItem('pasajero_telefono');
      detenerTrackingConductor();
      if (canalViajeConductor) {
        supabase.removeChannel(canalViajeConductor);
        canalViajeConductor = null;
      }
      detenerSeguimientoPosicionConductor();
      detenerListaPendientes();
      conductorTelefonoActual = null;
      conductorViajeActivo = null;
      driverActiveSheet.style.display = 'none';
      sheet.style.display = '';
      bloquearApp(true);
      searchInput.value = '';
      ocultarResultados();
      mostrarOverlay(roleSelectOverlay);
    }

    if (accion === 'historial') {
      abrirHistorial();
    }
  });
});

// ==================================================================
//  FASE 6 — Historial de viajes (pasajero y conductor)
// ==================================================================
const historialOverlay = document.getElementById('historial-overlay');
const historialLista = document.getElementById('historial-lista');
const btnCerrarHistorial = document.getElementById('btn-cerrar-historial');

function formatearFechaHistorial(fechaISO) {
  const fecha = new Date(fechaISO);
  return fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

async function abrirHistorial() {
  historialOverlay.classList.add('show');
  historialLista.innerHTML = '<div class="result-empty">Cargando...</div>';

  const rolActual = localStorage.getItem('rol');
  let query = supabase.from('viajes').select('*').in('estado', ['finalizado', 'cancelado']);

  if (rolActual === 'conductor' && conductorTelefonoActual) {
    query = query.eq('conductor_telefono', conductorTelefonoActual);
  } else {
    const usuario = cargarUsuario();
    if (!usuario) {
      historialLista.innerHTML = '<div class="result-empty">Sin viajes todavía</div>';
      return;
    }
    query = query.eq('telefono_pasajero', usuario.telefono);
  }

  const { data, error } = await query.order('creado_en', { ascending: false }).limit(50);

  if (error) {
    console.error('[Movi] Error trayendo historial:', error);
    historialLista.innerHTML = '<div class="result-empty">Error cargando el historial</div>';
    return;
  }

  if (!data || data.length === 0) {
    historialLista.innerHTML = '<div class="result-empty">Sin viajes todavía</div>';
    return;
  }

  // Traemos las paradas de todos estos viajes en una sola consulta para no
  // hacer N llamadas separadas (igual que en la lista de pendientes).
  const ids = data.map((v) => v.id);
  const { data: paradasData } = await supabase
    .from('paradas')
    .select('*')
    .in('viaje_id', ids)
    .order('orden', { ascending: true });

  const paradasPorViaje = {};
  (paradasData || []).forEach((p) => {
    if (!paradasPorViaje[p.viaje_id]) paradasPorViaje[p.viaje_id] = [];
    paradasPorViaje[p.viaje_id].push(p);
  });

  historialLista.innerHTML = data.map((v) => {
    const paradasViaje = paradasPorViaje[v.id] || [];
    const destinoTexto = paradasViaje.length === 0
      ? (v.destino_direccion || 'Destino sin especificar')
      : paradasViaje.length === 1
        ? (paradasViaje[0].direccion || 'Destino')
        : `${paradasViaje.length} paradas`;
    const origenTexto = v.origen_direccion || 'Origen sin especificar';
    const precioTexto = v.precio ? `$ ${Number(v.precio).toLocaleString('es-AR')}` : '$ —';
    const estadoTexto = v.estado === 'finalizado' ? 'Completado' : 'Cancelado';
    const estadoColor = v.estado === 'finalizado' ? 'var(--verde-fuerte)' : '#C0392B';

    return `
      <div class="parada-row" style="align-items:flex-start; flex-direction:column; gap:6px;">
        <div style="display:flex; justify-content:space-between; width:100%;">
          <span style="font-size:11.5px; font-weight:700; color:var(--texto-muted);">${formatearFechaHistorial(v.creado_en)}</span>
          <span style="font-size:11.5px; font-weight:800; color:${estadoColor};">${estadoTexto}</span>
        </div>
        <div style="font-size:13px; font-weight:700; color:var(--negro); line-height:1.4;">
          ${origenTexto} → ${destinoTexto}
        </div>
        <div style="font-size:13px; font-weight:800; color:var(--verde-fuerte);">${precioTexto}</div>
      </div>
    `;
  }).join('');
}

btnCerrarHistorial.addEventListener('click', () => {
  historialOverlay.classList.remove('show');
});

historialOverlay.addEventListener('click', (e) => {
  if (e.target === historialOverlay) historialOverlay.classList.remove('show');
});

// ==================================================================
//  Pago + calificacion: flujo de 2 pasos dentro de #payment-sheet.
//  Se dispara con el boton temporal "Simular fin de viaje" mientras
//  no haya logica real de fin de viaje.
// ==================================================================
const paymentStep1 = document.getElementById('payment-step-1');
const paymentStep2 = document.getElementById('payment-step-2');
const aliasCard = document.getElementById('alias-card');
const starsRow = document.getElementById('stars-row');
const commentInput = document.getElementById('comment-input');

function resetPaymentSheet() {
  const nombreConductor = document.querySelector('#driver-sheet .driver-name').textContent;
  const total = document.getElementById('ride-price-normal').textContent;

  document.getElementById('payment-driver-sub').textContent = `Con ${nombreConductor}`;
  document.getElementById('rating-driver-sub').textContent = `Con ${nombreConductor}`;
  document.getElementById('payment-total').textContent = total;

  document.querySelectorAll('.metodo-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.metodo === 'efectivo');
  });
  aliasCard.style.display = 'none';

  starsRow.querySelectorAll('.star').forEach((star) => star.classList.add('active'));
  commentInput.value = '';

  paymentStep1.style.display = 'block';
  paymentStep2.style.display = 'none';
}

document.getElementById('btn-simular-fin').addEventListener('click', () => {
  driverSheet.style.display = 'none';
  resetPaymentSheet();
  paymentSheet.style.display = 'block';
  paymentSheet.classList.remove('collapsed');
});

document.querySelectorAll('.metodo-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.metodo-chip').forEach((c) => c.classList.remove('selected'));
    chip.classList.add('selected');
    aliasCard.style.display = chip.dataset.metodo === 'transferencia' ? 'block' : 'none';
  });
});

document.getElementById('btn-confirmar-pago').addEventListener('click', () => {
  paymentStep1.style.display = 'none';
  paymentStep2.style.display = 'block';
});

starsRow.querySelectorAll('.star').forEach((star) => {
  star.addEventListener('click', () => {
    const seleccionadas = Number(star.dataset.index);
    starsRow.querySelectorAll('.star').forEach((s) => {
      s.classList.toggle('active', Number(s.dataset.index) <= seleccionadas);
    });
  });
});

document.getElementById('btn-enviar-calificacion').addEventListener('click', () => {
  const estrellas = starsRow.querySelectorAll('.star.active').length;
  console.log('[Movi] Calificacion enviada:', estrellas, 'estrellas. Comentario:', commentInput.value);

  paymentSheet.style.display = 'none';
  sheet.style.display = 'block';
  sheet.classList.remove('collapsed');
  viajeActivoPasajero = null;
  sincronizarCapaAutoConductor();
});

hacerArrastrable(paymentSheet);

// ================================================================
//  DEV / ADMIN PANEL
//  Funcionalidades de desarrollo para debug y testing.
// ================================================================

// --- Referencias DOM del panel ---
const devFloatingBtn = document.getElementById('dev-floating-btn');
const devPanelOverlay = document.getElementById('dev-panel-overlay');
const devPanelClose = document.getElementById('dev-panel-close');

// El boton flotante de dev solo se muestra si el usuario logueado es admin
function actualizarVisibilidadDevBtn() {
  devFloatingBtn.style.display = localStorage.getItem('es_admin') === 'true' ? 'grid' : 'none';
}
actualizarVisibilidadDevBtn();

const devTelefonoInput = document.getElementById('dev-telefono-input');
const devBtnTelefono = document.getElementById('dev-btn-telefono');
const devFeedbackTelefono = document.getElementById('dev-feedback-telefono');

const devBtnCrearViaje = document.getElementById('dev-btn-crear-viaje');
const devSelectEstado = document.getElementById('dev-select-estado');
const devBadgeEstado = document.getElementById('dev-badge-estado');
const devFeedbackViaje = document.getElementById('dev-feedback-viaje');

const devJsonViaje = document.getElementById('dev-json-viaje');

const devBtnResetear = document.getElementById('dev-btn-resetear');
const devFeedbackReset = document.getElementById('dev-feedback-reset');

const devBtnCancelar = document.getElementById('dev-btn-cancelar');
const devFeedbackCancelar = document.getElementById('dev-feedback-cancelar');

// --- Estado compartido del panel ---
let devViajeActivo = null;          // el viaje simulado o real que estamos trackeando
const SECCIONES_ESTADOS = ['pendiente', 'conductor_asignado', 'en_camino', 'llegó', 'en_viaje', 'finalizado'];
let devIndiceEstado = -1;           // -1 = no empezó, 0..n-1 = está en ese estado de la lista
let devIntervaloJson = null;        // intervalo de polling para mostrar JSON en vivo
let devSubscripcionJson = null;     // suscripción Realtime de Supabase

// El panel de dev simula viajes escribiendo directo en "viajes" (no pasa
// por el flujo real de btn-pedir-viaje), asi que viajeActivoPasajero nunca
// se enteraba de estos cambios y el auto del conductor (que depende de
// viajeActivoPasajero.estado/.conductor_telefono, ver sincronizarCapaAutoConductor
// mas arriba) nunca se activaba durante pruebas desde el panel. Este
// helper reemplaza toda asignacion directa a devViajeActivo para que
// ambos queden siempre sincronizados.
function devActualizarViajeActivo(data) {
  devViajeActivo = data;
  viajeActivoPasajero = data;
  sincronizarCapaAutoConductor();
}

// ---- Abrir / cerrar panel ----
devFloatingBtn.addEventListener('click', () => {
  devPanelOverlay.classList.add('show');
});

devPanelClose.addEventListener('click', () => {
  devPanelOverlay.classList.remove('show');
});

devPanelOverlay.addEventListener('click', (e) => {
  if (e.target === devPanelOverlay) {
    devPanelOverlay.classList.remove('show');
  }
});

// ---- Util: feedback temporal ----
function devMostrarFeedback(el, texto, error) {
  el.textContent = texto;
  el.classList.remove('error');
  if (error) el.classList.add('error');
  setTimeout(() => {
    if (el.textContent === texto) el.textContent = '';
  }, 2500);
}

// ==================================================================
//  1. CAMBIAR TELÉFONO DE PRUEBA
// ==================================================================
devBtnTelefono.addEventListener('click', () => {
  const numeroRaw = devTelefonoInput.value.replace(/\D/g, '');
  if (!numeroRaw || numeroRaw.length < 8) {
    devMostrarFeedback(devFeedbackTelefono, 'Número inválido (mín. 8 dígitos)', true);
    return;
  }

  const numero = formatearTelefonoConPrefijo(numeroRaw);
  const rolActual = localStorage.getItem('rol');

  if (rolActual === 'conductor') {
    localStorage.setItem('conductor_telefono', numero);
    devMostrarFeedback(devFeedbackTelefono, `Listo ✅ conductor_telefono = ${numero}`);
  } else if (rolActual === 'pasajero') {
    const usuario = cargarUsuario();
    if (usuario) {
      usuario.telefono = numero;
      localStorage.setItem(LS_KEY, JSON.stringify(usuario));
    } else {
      // Si no hay usuario logueado, creamos uno básico para testing
      const nuevo = { nombre: 'Test', telefono: numero };
      localStorage.setItem(LS_KEY, JSON.stringify(nuevo));
    }
    localStorage.setItem('pasajero_telefono', numero);
    devMostrarFeedback(devFeedbackTelefono, `Listo ✅ pasajero_telefono = ${numero}`);
  } else {
    // Sin rol definido: guardamos en todos lados por las dudas
    localStorage.setItem('conductor_telefono', numero);
    localStorage.setItem('pasajero_telefono', numero);
    const nuevo = { nombre: 'Test', telefono: numero };
    localStorage.setItem(LS_KEY, JSON.stringify(nuevo));
    devMostrarFeedback(devFeedbackTelefono, `Listo ✅ guardado en ambos roles = ${numero}`);
  }
});

// ==================================================================
//  2. SIMULAR VIAJE COMPLETO
// ==================================================================

// Coordenadas fijas cercanas al centro del mapa (Viedma)
const TEST_ORIGEN = { lat: -40.8120, lng: -62.9950 };
const TEST_DESTINO = { lat: -40.8090, lng: -62.9900 };
const TEST_DIRECCION_ORIGEN = 'San Martín 250, Viedma';
const TEST_DIRECCION_DESTINO = 'Belgrano 450, Viedma';

devBtnCrearViaje.addEventListener('click', async () => {
  devBtnCrearViaje.disabled = true;
  devBtnCrearViaje.textContent = 'Creando...';

  const usuarioActual = cargarUsuario();
  const telefonoPasajero = usuarioActual ? usuarioActual.telefono : '5492920999999';

  // FIX: antes se usaba buscarConductorDisponible(), que busca CUALQUIER
  // conductor real marcado como disponible=true en la tabla "conductores".
  // Si una persona real (ej. un conductor de verdad probando la app) queda
  // disponible, el viaje de prueba le pisaba su telefono real, y la
  // simulacion de movimiento del auto terminaba escribiendo posiciones
  // falsas sobre su fila de conductor real. El panel de dev ahora usa
  // SIEMPRE el conductor de prueba fijo, sembrado a mano en Supabase, para
  // que las pruebas queden 100% aisladas de cualquier usuario real.
  const datosConductor = {
    nombre_conductor: 'Leyvan Esquercia',
    conductor_telefono: TELEFONO_CONDUCTOR_PRUEBA,
    patente_conductor: 'AB123CD',
    modelo_auto_conductor: 'Toyota Corolla',
    color_auto_conductor: 'Gris',
  };

  const { data, error } = await supabase
    .from('viajes')
    .insert({
      estado: 'pendiente',
      es_prueba: true,
      eta_minutos: 3,
      telefono_pasajero: telefonoPasajero,
      precio: 2500,
      origen_direccion: TEST_DIRECCION_ORIGEN,
      origen_lat: TEST_ORIGEN.lat,
      origen_lng: TEST_ORIGEN.lng,
      destino_direccion: TEST_DIRECCION_DESTINO,
      destino_lat: TEST_DESTINO.lat,
      destino_lng: TEST_DESTINO.lng,
      ...datosConductor,
    })
    .select()
    .single();

  devBtnCrearViaje.disabled = false;
  devBtnCrearViaje.textContent = 'Crear viaje de prueba';

  if (error) {
    console.error('[Dev] Error creando viaje de prueba:', error);
    devMostrarFeedback(devFeedbackViaje, 'Error al crear viaje ❌', true);
    return;
  }

  devActualizarViajeActivo(data);
  devIndiceEstado = 0; // arrancamos en pendiente (ya está)
  devBadgeEstado.textContent = 'pendiente';
  devSelectEstado.value = 'pendiente';
  devSelectEstado.disabled = false;
  devMostrarFeedback(devFeedbackViaje, `Viaje creado ✅ ID: ${data.id}`);
  devActualizarJson(data);
});

devSelectEstado.addEventListener('change', async () => {
  if (!devViajeActivo) return;

  const nuevoEstado = devSelectEstado.value;
  devSelectEstado.disabled = true;

  const { data, error } = await supabase
    .from('viajes')
    .update({ estado: nuevoEstado })
    .eq('id', devViajeActivo.id)
    .select()
    .single();

  devSelectEstado.disabled = false;

  if (error) {
    console.error('[Dev] Error actualizando estado:', error);
    devMostrarFeedback(devFeedbackViaje, 'Error al cambiar estado ❌', true);
    return;
  }

  devActualizarViajeActivo(data);
  devIndiceEstado = SECCIONES_ESTADOS.indexOf(nuevoEstado);
  devBadgeEstado.textContent = nuevoEstado;
  devMostrarFeedback(devFeedbackViaje, `Ahora: ${nuevoEstado}`);

  devActualizarJson(data);
});

// ==================================================================
//  2b. MOVER AUTO DEL CONDUCTOR (tocar el mapa lo teleporta)
//  Escribe lat/lng/heading directo en "conductores" para el telefono del
//  viaje activo (o el conductor de prueba sembrado si todavia no hay
//  viaje), asi se prueba la cadena completa: Supabase -> Realtime ->
//  aplicarNuevaPosicionConductor -> capa "auto-conductor" en el mapa.
// ==================================================================
const devBtnMoverAuto = document.getElementById('dev-btn-mover-auto');
const devFeedbackMoverAuto = document.getElementById('dev-feedback-mover-auto');

const TELEFONO_CONDUCTOR_PRUEBA = '5492920123456'; // Leyvan Esquercia, sembrado a mano en Supabase

let devModoMoverAuto = false;

devBtnMoverAuto.addEventListener('click', () => {
  devModoMoverAuto = !devModoMoverAuto;

  if (devModoMoverAuto) {
    devBtnMoverAuto.textContent = 'Desactivar (tocando el mapa se mueve el auto)';
    devBtnMoverAuto.classList.add('dev-btn-danger');
    devMostrarFeedback(devFeedbackMoverAuto, 'Modo activo: tocá el mapa para mover el auto');
    // Cerramos el panel para poder tocar el mapa (el overlay del panel
    // tapa toda la pantalla, no solo la hoja inferior).
    devPanelOverlay.classList.remove('show');
  } else {
    devBtnMoverAuto.textContent = 'Activar: tocar el mapa mueve el auto';
    devBtnMoverAuto.classList.remove('dev-btn-danger');
    devMostrarFeedback(devFeedbackMoverAuto, 'Modo desactivado');
  }
});

async function devMoverAutoA(lat, lng) {
  const telefono = viajeActivoPasajero?.conductor_telefono
    || devViajeActivo?.conductor_telefono
    || TELEFONO_CONDUCTOR_PRUEBA;

  const heading = posicionConductor ? calcularRumbo(posicionConductor, { lat, lng }) : 0;

  const { error } = await supabase
    .from('conductores')
    .update({ lat, lng, heading, actualizado_en: new Date().toISOString() })
    .eq('telefono', telefono);

  if (error) {
    console.error('[Dev] Error moviendo el auto de prueba:', error);
    devMostrarFeedback(devFeedbackMoverAuto, 'Error al mover el auto ❌', true);
    return;
  }

  devMostrarFeedback(devFeedbackMoverAuto, `Auto movido ✅ (${telefono})`);
}

// ==================================================================
//  2c. SIMULAR RECORRIDO AUTOMÁTICO (sin caminar de verdad con el celu)
//  Calcula una ruta real con getRuta() y va escribiendo puntos de esa
//  geometria, uno por uno, en la tabla "conductores" (mismo mecanismo que
//  el click-en-el-mapa de arriba) — asi se ve el auto moviendose solo por
//  la ruta y enganchado a la calle, sin que nadie tenga que caminar con
//  el telefono en la mano para probarlo.
// ==================================================================
const devBtnSimularOrigen = document.getElementById('dev-btn-simular-origen');
const devBtnSimularDestino = document.getElementById('dev-btn-simular-destino');
const devBtnDetenerSimulacion = document.getElementById('dev-btn-detener-simulacion');
const devFeedbackSimulacion = document.getElementById('dev-feedback-simulacion');

// Punto de partida ficticio, unas cuadras al sur del origen de prueba, para
// simular que el conductor viene acercandose desde algun lado.
const TEST_PUNTO_PARTIDA = { lat: -40.8175, lng: -62.9955 };

let devSimulacionIntervalId = null;

function devDetenerSimulacion(mensaje) {
  if (devSimulacionIntervalId) {
    clearInterval(devSimulacionIntervalId);
    devSimulacionIntervalId = null;
  }
  if (mensaje) devMostrarFeedback(devFeedbackSimulacion, mensaje);
}

async function devSimularRecorrido(puntos, textoOk) {
  devDetenerSimulacion();
  devMostrarFeedback(devFeedbackSimulacion, 'Calculando ruta...');

  const ruta = await getRuta(puntos);
  if (!ruta || !ruta.geometry?.coordinates?.length) {
    devMostrarFeedback(devFeedbackSimulacion, 'No se pudo calcular la ruta ❌', true);
    return;
  }

  // Tambien la dibujamos en el mapa (mismo source que usa el resto de la
  // app), asi se ve la linea ademas del auto moviendose sobre ella.
  if (map.getSource('ruta')) {
    map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
  }
  rutaGeometriaActual = ruta.geometry.coordinates;
  window._iniciarAnimacionGlow?.();

  const coords = ruta.geometry.coordinates; // [[lng,lat], ...]
  const pasosDeseados = 35; // cuantas actualizaciones de posicion mandamos en total
  const salto = Math.max(1, Math.floor(coords.length / pasosDeseados));
  let i = 0;

  devMostrarFeedback(devFeedbackSimulacion, 'Simulando... 🚗');

  devSimulacionIntervalId = setInterval(async () => {
    if (i >= coords.length) {
      devDetenerSimulacion(textoOk);
      return;
    }
    const [lng, lat] = coords[i];
    await devMoverAutoA(lat, lng);
    i += salto;
  }, 700); // similar al intervalo real entre actualizaciones de GPS
}

devBtnSimularOrigen.addEventListener('click', () => {
  devSimularRecorrido([TEST_PUNTO_PARTIDA, TEST_ORIGEN], 'Auto llegó al origen ✅');
});

devBtnSimularDestino.addEventListener('click', async () => {
  // Si el viaje de prueba tiene paradas cargadas (tabla "paradas"), la ruta
  // pasa por todas en orden; si no, va directo origen -> destino de prueba.
  let puntos = [TEST_ORIGEN, TEST_DESTINO];

  if (devViajeActivo) {
    const { data: paradasViaje } = await supabase
      .from('paradas')
      .select('*')
      .eq('viaje_id', devViajeActivo.id)
      .order('orden', { ascending: true });

    if (paradasViaje && paradasViaje.length > 0) {
      puntos = [TEST_ORIGEN, ...paradasViaje.map((p) => ({ lat: p.lat, lng: p.lng }))];
    }
  }

  devSimularRecorrido(puntos, 'Auto llegó al destino ✅');
});

devBtnDetenerSimulacion.addEventListener('click', () => {
  devDetenerSimulacion('Simulación detenida');
});

// ==================================================================
//  3. VER ESTADO CRUDO DEL VIAJE (en vivo, vía Realtime)
// ==================================================================

function devActualizarJson(data) {
  if (data) {
    devJsonViaje.textContent = JSON.stringify(data, null, 2);
  } else {
    devJsonViaje.textContent = 'Sin viaje activo';
  }
}

// Iniciar suscripción Realtime cuando se abre el panel
function devIniciarSuscripcionJson() {
  devDetenerSuscripcionJson();

  // Si ya tenemos un viaje activo, escuchamos cambios en él
  if (!devViajeActivo) {
    // Buscamos el último viaje activo (no finalizado) del pasajero o el simulado
    const usuario = cargarUsuario();
    if (usuario && usuario.telefono) {
      devSubscripcionJson = supabase
        .channel('dev-viaje-json')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'viajes',
            filter: `telefono_pasajero=eq.${usuario.telefono}`,
          },
          (payload) => {
            const nuevo = payload.new;
            if (nuevo && nuevo.estado !== 'finalizado' && nuevo.estado !== 'cancelado') {
              devActualizarViajeActivo(nuevo);
              devActualizarJson(nuevo);
            }
          }
        )
        .subscribe();
    }
    return;
  }

  // Si tenemos un viaje activo, escuchamos cambios en ese ID específico
  devSubscripcionJson = supabase
    .channel('dev-viaje-json-activo')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'viajes',
        filter: `id=eq.${devViajeActivo.id}`,
      },
      (payload) => {
        const nuevo = payload.new;
        devActualizarViajeActivo(nuevo);
        devActualizarJson(nuevo);

        // Si el viaje fue finalizado o cancelado por otra vía, actualizamos badge
        if (nuevo && SECCIONES_ESTADOS.includes(nuevo.estado)) {
          devBadgeEstado.textContent = nuevo.estado;
          devSelectEstado.value = nuevo.estado;
          devIndiceEstado = SECCIONES_ESTADOS.indexOf(nuevo.estado);
        }
      }
    )
    .subscribe();
}

function devDetenerSuscripcionJson() {
  if (devSubscripcionJson) {
    supabase.removeChannel(devSubscripcionJson);
    devSubscripcionJson = null;
  }
}

// Iniciar/Detener suscripción al abrir/cerrar el panel
// También hacemos polling por si Realtime tarda
devPanelOverlay.addEventListener('transitionend', () => {
  if (devPanelOverlay.classList.contains('show')) {
    devIniciarSuscripcionJson();
  } else {
    devDetenerSuscripcionJson();
  }
});

// Fallback: también manejamos con MutationObserver por si transitionend no se dispara
const devObserver = new MutationObserver(() => {
  if (devPanelOverlay.classList.contains('show')) {
    devIniciarSuscripcionJson();
  } else {
    devDetenerSuscripcionJson();
  }
});
devObserver.observe(devPanelOverlay, { attributes: true, attributeFilter: ['class'] });

// Polling periódico como respaldo (cada 3s)
devIntervaloJson = setInterval(async () => {
  if (!devPanelOverlay.classList.contains('show')) return;

  if (devViajeActivo && devViajeActivo.id) {
    const { data, error } = await supabase
      .from('viajes')
      .select('*')
      .eq('id', devViajeActivo.id)
      .maybeSingle();

    if (!error && data) {
      // Solo actualizamos si cambió algo
      if (JSON.stringify(data) !== JSON.stringify(devViajeActivo)) {
        devActualizarViajeActivo(data);
        devActualizarJson(data);

        if (SECCIONES_ESTADOS.includes(data.estado)) {
          devBadgeEstado.textContent = data.estado;
          devSelectEstado.value = data.estado;
          devIndiceEstado = SECCIONES_ESTADOS.indexOf(data.estado);
        }
      }
    }
  } else {
    // No hay viaje activo trackeado: buscar el último viaje de prueba
    const { data, error } = await supabase
      .from('viajes')
      .select('*')
      .eq('es_prueba', true)
      .order('creado_en', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      devActualizarViajeActivo(data);
      devActualizarJson(data);
      if (SECCIONES_ESTADOS.includes(data.estado)) {
        devBadgeEstado.textContent = data.estado;
        devSelectEstado.value = data.estado;
        devIndiceEstado = SECCIONES_ESTADOS.indexOf(data.estado);
      }
    }
  }
}, 3000);

// ==================================================================
//  4. RESETEAR DATOS DE PRUEBA
// ==================================================================
devBtnResetear.addEventListener('click', async () => {
  devBtnResetear.disabled = true;
  devBtnResetear.textContent = 'Borrando...';

  const { error } = await supabase
    .from('viajes')
    .delete()
    .eq('es_prueba', true);

  devBtnResetear.disabled = false;
  devBtnResetear.textContent = 'Borrar todos los viajes de prueba';

  if (error) {
    console.error('[Dev] Error borrando viajes de prueba:', error);
    devMostrarFeedback(devFeedbackReset, 'Error al borrar ❌', true);
    return;
  }

  // Si el viaje activo era de prueba, lo limpiamos
  if (devViajeActivo && devViajeActivo.es_prueba) {
    devActualizarViajeActivo(null);
    devIndiceEstado = -1;
    devBadgeEstado.textContent = '—';
    devSelectEstado.disabled = true;
    devActualizarJson(null);
  }

  devMostrarFeedback(devFeedbackReset, 'Listo ✅ viajes de prueba eliminados');
});

// ==================================================================
//  5. FORZAR CANCELACIÓN
// ==================================================================
devBtnCancelar.addEventListener('click', async () => {
  if (!devViajeActivo) {
    devMostrarFeedback(devFeedbackCancelar, 'No hay viaje activo para cancelar', true);
    return;
  }

  if (devViajeActivo.estado === 'cancelado') {
    devMostrarFeedback(devFeedbackCancelar, 'El viaje ya está cancelado', false);
    return;
  }

  devBtnCancelar.disabled = true;
  devBtnCancelar.textContent = 'Cancelando...';

  const { data, error } = await supabase
    .from('viajes')
    .update({ estado: 'cancelado' })
    .eq('id', devViajeActivo.id)
    .select()
    .single();

  devBtnCancelar.disabled = false;
  devBtnCancelar.textContent = 'Cancelar viaje activo';

  if (error) {
    console.error('[Dev] Error cancelando viaje:', error);
    devMostrarFeedback(devFeedbackCancelar, 'Error al cancelar ❌', true);
    return;
  }

  devActualizarViajeActivo(data);
  devBadgeEstado.textContent = 'cancelado';
  devSelectEstado.disabled = true;
  devActualizarJson(data);
  devMostrarFeedback(devFeedbackCancelar, 'Listo ✅ viaje cancelado');
});