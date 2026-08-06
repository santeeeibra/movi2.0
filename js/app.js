// ==================================================================
//  Movi — reinicio limpio. Solo lo esencial: mostrar el mapa.
// ==================================================================

import * as Sentry from '@sentry/browser';
import { supabase, getLugares, searchLugares, reverseGeocode, registrarSeleccionDeLugar, distanciaMetros } from './databaseservice.js';
import { MAPBOX_TOKEN } from './config.js';
import { searchMapbox, getRuta } from './apiservices.js';
import { initMonitoring } from './monitoring.js';

// ==================================================================
//  SISTEMA ANTI-CACHE-VIEJO: cada build tiene un identificador unico
//  (timestamp de cuando se compilo, ver vite.config.js). Si el
//  guardado en este dispositivo no coincide con el de la version que
//  se acaba de cargar, es que habia quedado algo viejo dando vueltas
//  (service worker, cache del navegador) — se limpia todo eso y se
//  recarga UNA sola vez, de forma automatica y transparente. Con esto
//  no deberia hacer falta nunca mas pedirle a nadie que borre cache a
//  mano para ver los cambios nuevos.
// ==================================================================
if (import.meta.env.PROD && typeof __APP_BUILD__ !== 'undefined') {
  const versionGuardada = localStorage.getItem('app_build_version');
  const yaRecargoPorEstaVersion = sessionStorage.getItem('app_ya_recargo_por_version');

  if (versionGuardada && versionGuardada !== __APP_BUILD__ && !yaRecargoPorEstaVersion) {
    sessionStorage.setItem('app_ya_recargo_por_version', '1');

    const limpiarServiceWorkers = 'serviceWorker' in navigator
      ? navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister())))
      : Promise.resolve();

    const limpiarCaches = 'caches' in window
      ? caches.keys().then((claves) => Promise.all(claves.map((k) => caches.delete(k))))
      : Promise.resolve();

    Promise.all([limpiarServiceWorkers, limpiarCaches]).finally(() => {
      localStorage.setItem('app_build_version', __APP_BUILD__);
      window.location.reload();
    });
  } else {
    localStorage.setItem('app_build_version', __APP_BUILD__);
  }
}

Sentry.init({
  dsn: "https://7bc90b9a17ed004fbac2a7997ab37093@o4511797812920320.ingest.de.sentry.io/4511797825437776",
  integrations: [],
  tracesSampleRate: 1.0,
});

initMonitoring();

// ==================================================================
//  Capturador de errores visible EN PANTALLA (temporal, para
//  diagnosticar sin necesitar herramientas de desarrollador desde el
//  celular). Muestra cualquier error de JS o promesa rechazada como un
//  cartel rojo abajo de todo, independiente de cualquier otro sistema
//  de la app (para que funcione incluso si algo mas esta roto).
// ==================================================================
function mostrarErrorEnPantalla(texto) {
  let el = document.getElementById('debug-error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'debug-error-banner';
    el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:999999;background:#c0392b;color:#fff;padding:12px;border-radius:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;max-height:45vh;overflow:auto;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
    document.body.appendChild(el);
  }
  el.textContent += (el.textContent ? '\n---\n' : '⚠️ ERROR (tocá para copiar todo)\n') + texto;
  el.onclick = () => {
    navigator.clipboard?.writeText(el.textContent).catch(() => {});
  };
}
window.addEventListener('error', (e) => {
  mostrarErrorEnPantalla(`${e.message}\n(archivo: ${e.filename?.split('/').pop() || '?'}, línea ${e.lineno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  mostrarErrorEnPantalla(`Promesa rechazada: ${e.reason?.message || e.reason}`);
});

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
const paradasFloatBar = document.getElementById('paradas-float-bar');
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

// FIX: se usaba en iniciarSupervisionViajeConductor(), que se llama de
// forma sincronica al cargar la pagina (ver mas abajo, "Inicial: decidir
// que mostrar") para cualquiera que ya tenga un telefono de conductor
// guardado — si esta declaracion quedaba mas abajo en el archivo (como
// estaba antes), esa llamada fallaba con un ReferenceError de "variable
// no inicializada" (temporal dead zone) apenas cargaba la pagina, y como
// era un error sincronico en la carga inicial del modulo, TODO el codigo
// que venia despues en el archivo (incluidos botones agregados
// despues, como "Salir") nunca llegaba a registrarse.
let canalViajeConductor = null;

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

  // Cabecera de perfil dentro del menu (drawer izquierdo): misma info,
  // reflejada tambien ahi para que ambos drawers queden consistentes.
  const menuAvatar = document.querySelector('#menu-profile-card .menu-profile-avatar');
  const menuNombre = document.querySelector('#menu-profile-card .menu-profile-name');
  if (usuario && menuAvatar && menuNombre) {
    menuAvatar.textContent = usuario.nombre.charAt(0).toUpperCase();
    menuNombre.textContent = usuario.nombre;
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
const conductorVerificarOverlay = document.getElementById('conductor-verificar-overlay');
const driverWaitingOverlay = document.getElementById('driver-waiting-overlay');

const btnSoyPasajero = document.getElementById('btn-soy-pasajero');
const btnSoyConductor = document.getElementById('btn-soy-conductor');

// Conductor form fields
const conductorNombre = document.getElementById('conductor-nombre');
const conductorTelefono = document.getElementById('conductor-telefono');
const conductorPatente = document.getElementById('conductor-patente');
const conductorModelo = document.getElementById('conductor-modelo');
const btnGuardarConductor = document.getElementById('btn-guardar-conductor');
const conductorMsg = document.getElementById('conductor-msg');

// Paleta fija de colores del auto: el texto es lo que se guarda en
// Supabase (color_auto, igual que antes) y se muestra en el detalle
// del viaje; el hex es lo que usa el modelo 3D del auto en el mapa
// (ver capa 'auto-paint' en map.on('load') mas abajo).
const COLORES_AUTO = {
  Rojo: '#D64545',
  Azul: '#3B6FD6',
  Gris: '#8C8C8C',
  Negro: '#1A1A1A',
  Blanco: '#F2F2F2',
  Verde: '#1F8A4C',
  Violeta: '#8B5CF6',
  Celeste: '#38BDF8',
  Amarillo: '#FACC15',
  Naranja: '#F97316',
};
const COLOR_AUTO_DEFAULT = '#8C8C8C'; // gris, si el conductor no tiene color guardado

const colorChipRow = document.getElementById('conductor-color-row');
let colorAutoSeleccionado = null;

colorChipRow?.addEventListener('click', (e) => {
  const chip = e.target.closest('.color-chip');
  if (!chip) return;
  colorChipRow.querySelectorAll('.color-chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  colorAutoSeleccionado = chip.dataset.color;
});

function mostrarOverlay(el) {
  [roleSelectOverlay, loginOverlay, conductorFormOverlay, conductorVerificarOverlay, driverWaitingOverlay]
    .forEach(o => o.classList.remove('show'));
  if (el) el.classList.add('show');
}

// ==================================================================
//  Verificacion de telefono por SMS (Twilio Verify via Supabase Edge
//  Functions "enviar-codigo" / "verificar-codigo"). Ver CLAUDE.md.
// ==================================================================
const SUPABASE_FUNCTIONS_URL = 'https://lapnbdpdkkeaaavvkfqc.supabase.co/functions/v1';

async function enviarCodigoSMS(telefono) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/enviar-codigo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error || 'No se pudo enviar el codigo' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Movi] Error de red enviando codigo SMS:', err);
    return { ok: false, error: 'Sin conexion. Revisá tu internet e intentá de nuevo.' };
  }
}

async function verificarCodigoSMS(telefono, codigo) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/verificar-codigo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono, codigo }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || 'Código incorrecto o vencido' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Movi] Error de red verificando codigo SMS:', err);
    return { ok: false, error: 'Sin conexion. Revisá tu internet e intentá de nuevo.' };
  }
}

let telefonoConductorPendienteVerificar = null;

// FIX: estos dos botones tienen el HTML/CSS desde hace rato (Fase 0),
// pero nunca llegaron a tener el addEventListener enganchado — se
// perdio en algun punto de tantas idas y vueltas durante la sesion.
// Vuelven a la seleccion de rol sin guardar nada.
document.getElementById('btn-atras-login')?.addEventListener('click', () => {
  mostrarOverlay(roleSelectOverlay);
  bloquearApp(true);
});
document.getElementById('btn-atras-conductor')?.addEventListener('click', () => {
  mostrarOverlay(roleSelectOverlay);
  bloquearApp(true);
});

// ==================================================================
//  Notificaciones dentro de la app — reemplaza lo que iba a ser un
//  aviso por WhatsApp (conductor asignado, llego, viaje iniciado,
//  finalizado, cancelado, nuevo viaje disponible para el conductor).
//  Se apilan una a la vez: si llega una nueva mientras se esta
//  mostrando otra, se corta la anterior y se muestra la nueva.
// ==================================================================
const appToast = document.getElementById('app-toast');
const appToastIcon = document.getElementById('app-toast-icon');
const appToastTexto = document.getElementById('app-toast-texto');
let appToastTimeoutId = null;

function mostrarToast(texto, icono = '🔔', duracionMs = 4500) {
  if (appToastTimeoutId) {
    clearTimeout(appToastTimeoutId);
    appToastTimeoutId = null;
  }

  appToast.classList.remove('hiding');
  appToastIcon.textContent = icono;
  appToastTexto.textContent = texto;
  appToast.classList.remove('show');
  void appToast.offsetWidth;
  appToast.classList.add('show');

  appToastTimeoutId = setTimeout(() => {
    appToast.classList.add('hiding');
    setTimeout(() => {
      appToast.classList.remove('show', 'hiding');
    }, 250);
  }, duracionMs);
}

// ==================================================================
//  Confirmacion propia (reemplaza window.confirm): algunos navegadores
//  mobile, sobre todo en modo PWA instalada/standalone, bloquean o
//  ignoran en silencio los dialogos nativos (confirm/alert/prompt) —
//  el boton que los dispara queda pareciendo que "no hace nada". Este
//  modal esta dibujado dentro de la app, asi que siempre funciona.
// ==================================================================
const confirmOverlay = document.getElementById('confirm-overlay');
const confirmTexto = document.getElementById('confirm-texto');
const confirmBtnSi = document.getElementById('confirm-btn-si');
const confirmBtnNo = document.getElementById('confirm-btn-no');

function mostrarConfirm(texto, textoConfirmar = 'Confirmar', textoCancelar = 'Cancelar') {
  return new Promise((resolve) => {
    confirmTexto.textContent = texto;
    confirmBtnSi.textContent = textoConfirmar;
    confirmBtnNo.textContent = textoCancelar;
    confirmOverlay.classList.add('show');

    function limpiar() {
      confirmOverlay.classList.remove('show');
      confirmBtnSi.removeEventListener('click', onSi);
      confirmBtnNo.removeEventListener('click', onNo);
    }
    function onSi() { limpiar(); resolve(true); }
    function onNo() { limpiar(); resolve(false); }

    confirmBtnSi.addEventListener('click', onSi);
    confirmBtnNo.addEventListener('click', onNo);
  });
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
  const colorAuto = colorAutoSeleccionado;

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
    conductorMsg.textContent = 'Elegí el color del auto';
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

  // FASE BETA: verificacion por SMS desactivada para todos los
  // conductores (Twilio trial no manda SMS a numeros no verificados).
  // Para reactivarla mas adelante, restaurar el bloque original de git.
  if (esAdminConductor) {
    localStorage.setItem('es_admin', 'true');
    actualizarVisibilidadDevBtn();
  }
  btnGuardarConductor.textContent = '¡Listo!';
  mostrarOverlay(driverWaitingOverlay);
  btnGuardarConductor.disabled = false;
  btnGuardarConductor.textContent = 'Ingresar';
  iniciarSupervisionViajeConductor(telefono);
  return;

  // Conductor real: antes de dejarlo entrar, verificamos que el
  // telefono es suyo de verdad con un codigo por SMS.
  telefonoConductorPendienteVerificar = telefono;
  const envio = await enviarCodigoSMS(telefono);

  btnGuardarConductor.disabled = false;
  btnGuardarConductor.textContent = 'Ingresar';

  if (!envio.ok) {
    conductorMsg.textContent = envio.error;
    conductorMsg.style.color = '#C0392B';
    return;
  }

  conductorVerificarSub.textContent = `Te mandamos un código por SMS al ${telefono}`;
  conductorVerificarMsg.textContent = '';
  conductorCodigoInput.value = '';
  mostrarOverlay(conductorVerificarOverlay);
});

// Referencias de la pantalla de verificacion de codigo
const conductorVerificarSub = document.getElementById('conductor-verificar-sub');
const conductorCodigoInput = document.getElementById('conductor-codigo');
const conductorVerificarMsg = document.getElementById('conductor-verificar-msg');
const btnVerificarCodigo = document.getElementById('btn-verificar-codigo');

btnVerificarCodigo.addEventListener('click', async () => {
  const codigo = conductorCodigoInput.value.trim();
  if (!codigo) {
    conductorVerificarMsg.textContent = 'Ingresá el código que te llegó';
    conductorVerificarMsg.style.color = '#C0392B';
    return;
  }

  btnVerificarCodigo.disabled = true;
  btnVerificarCodigo.textContent = 'Verificando...';
  conductorVerificarMsg.textContent = '';

  const resultado = await verificarCodigoSMS(telefonoConductorPendienteVerificar, codigo);

  btnVerificarCodigo.disabled = false;
  btnVerificarCodigo.textContent = 'Verificar';

  if (!resultado.ok) {
    conductorVerificarMsg.textContent = resultado.error;
    conductorVerificarMsg.style.color = '#C0392B';
    return;
  }

  mostrarOverlay(driverWaitingOverlay);
  iniciarSupervisionViajeConductor(telefonoConductorPendienteVerificar);
});

document.getElementById('btn-reenviar-codigo')?.addEventListener('click', async () => {
  if (!telefonoConductorPendienteVerificar) return;
  conductorVerificarMsg.style.color = '';
  conductorVerificarMsg.textContent = 'Reenviando...';
  const envio = await enviarCodigoSMS(telefonoConductorPendienteVerificar);
  conductorVerificarMsg.textContent = envio.ok ? 'Código reenviado.' : envio.error;
  conductorVerificarMsg.style.color = envio.ok ? '#1F8A4C' : '#C0392B';
});

document.getElementById('btn-atras-verificar')?.addEventListener('click', () => {
  mostrarOverlay(conductorFormOverlay);
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
      mostrarToast('No pudimos acceder a tu ubicación — revisá los permisos del navegador 📍', '⚠️');
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

// Cierra la sesion actual (pasajero o conductor) y vuelve a la
// seleccion de rol. Reusada tanto desde el drawer ("Cerrar sesion")
// como desde el boton "Salir" de la pantalla de espera del conductor
// (necesario porque esa pantalla es de pantalla completa y tapa el
// menu/topbar, asi que sin este boton no habia forma de volver atras
// si uno entraba a modo conductor por error o quiere cambiar de rol).
function cerrarSesion() {
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem('rol');
  localStorage.removeItem('conductor_telefono');
  localStorage.removeItem('pasajero_telefono');
  localStorage.removeItem('es_admin');
  detenerTrackingConductor();
  if (canalViajeConductor) {
    supabase.removeChannel(canalViajeConductor);
    canalViajeConductor = null;
  }
  detenerSeguimientoPosicionConductor();
  detenerListaPendientes();
  simAutoDetener();
  conductorTelefonoActual = null;
  conductorViajeActivo = null;
  conductorDisponible = false;
  driverActiveSheet.style.display = 'none';
  sheet.style.display = '';
  bloquearApp(true);
  searchInput.value = '';
  ocultarResultados();
  actualizarVisibilidadDevBtn();
  mostrarOverlay(roleSelectOverlay);
}

document.getElementById('btn-salir-conductor')?.addEventListener('click', async () => {
  const confirmar = await mostrarConfirm('¿Cerrar sesión como conductor y volver a elegir el rol?', 'Cerrar sesión', 'Seguir conectado');
  if (confirmar) cerrarSesion();
});

function actualizarToggleUI() {
  toggleDisponible.setAttribute('aria-checked', String(conductorDisponible));
  driverDisponibleLabel.textContent = conductorDisponible
    ? 'Conectado — recibiendo viajes'
    : 'Conectarte para recibir viajes';
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
      (payload) => {
        if (payload.eventType === 'INSERT') {
          mostrarToast('Nuevo viaje disponible cerca tuyo 🔔', '🔔');
        }
        refrescarListaPendientes();
      },
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
  // FIX: si en esta misma sesion de navegador ya se uso la app como
  // pasajero y se llego a ver "Viaje completado" (payment-sheet), ese
  // sheet queda con display:block colgado en el DOM — sheet.style de
  // arriba no lo tapa porque es otro elemento. Sin esto se ve apilado
  // arriba de "Viaje en curso" al entrar en modo conductor.
  paymentSheet.style.display = 'none';
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

// Estilo de la linea de ruta: distingue visualmente el tramo "yendo a
// buscar al pasajero" (azul, punteado) del tramo real del viaje ya con
// el pasajero a bordo (verde solido, color de marca). Reutiliza las
// mismas capas 'ruta-glow'/'ruta-linea' en vez de duplicarlas — como
// nunca se muestran los dos tramos a la vez, alcanza con cambiar el
// paint antes de cargar los datos de cada tramo.
function aplicarEstiloRuta(tipo) {
  if (!map.getLayer('ruta-linea') || !map.getLayer('ruta-glow')) return;

  if (tipo === 'hacia_pasajero') {
    map.setPaintProperty('ruta-linea', 'line-color', '#2E7DD7');
    map.setPaintProperty('ruta-linea', 'line-dasharray', [2, 1.6]);
    map.setPaintProperty('ruta-glow', 'line-color', '#2E7DD7');
  } else {
    // 'viaje': el color de marca de Movi, linea solida.
    map.setPaintProperty('ruta-linea', 'line-color', '#1F8A4C');
    map.setPaintProperty('ruta-linea', 'line-dasharray', [1, 0]);
    map.setPaintProperty('ruta-glow', 'line-color', '#ffffff');
  }
}

async function dibujarRutaConductorHaciaOrigen(viaje) {
  const posActual = await obtenerPosicionActualConductor();
  if (!posActual) return;

  const destino = { lat: viaje.origen_lat, lng: viaje.origen_lng };
  const ruta = await getRuta([posActual, destino]);
  if (!ruta || !map.getSource('ruta')) return;

  // FIX: antes el ETA quedaba fijo en el "3" de aceptarViaje para
  // siempre. Ahora que ya calculamos la ruta real hacia el origen,
  // guardamos la duracion real en minutos.
  const etaReal = Math.max(1, Math.round(ruta.minutos));
  await supabase.from('viajes').update({ eta_minutos: etaReal }).eq('id', viaje.id);

  aplicarEstiloRuta('hacia_pasajero');
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

  aplicarEstiloRuta('viaje');
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
      // Si el conductor mismo lo finalizo (toco "Finalizar viaje"), ya lo
      // sabe — el aviso es solo para cuando se entera de una cancelacion.
      if (viaje && viaje.estado === 'cancelado') {
        const tarifa = Number(viaje.tarifa_cancelacion) || 0;
        mostrarToast(
          tarifa > 0
            ? `El pasajero canceló — se le cobró $${tarifa.toLocaleString('es-AR')} por tu tiempo 💰`
            : 'El pasajero canceló el viaje ❌',
          tarifa > 0 ? '💰' : '❌',
        );
      }
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

// FIX (mismo motivo que del lado del pasajero): si el celular del
// conductor se puso en reposo, el navegador puede cortar la conexion en
// tiempo real sin avisar — por ejemplo, si el pasajero cancela justo en
// ese momento, el conductor nunca se entera. Al volver a la pestaña,
// chequeamos a mano si su viaje activo sigue igual.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!conductorTelefonoActual) return;

  supabase
    .from('viajes')
    .select('*')
    .eq('conductor_telefono', conductorTelefonoActual)
    .not('estado', 'in', '(pendiente,finalizado,cancelado)')
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle()
    .then(({ data: viajeReal, error }) => {
      if (error) return;
      // Si el viaje real que deberia estar activo cambio (o desaparecio)
      // respecto a lo que teniamos en pantalla, nos ponemos al dia.
      if ((viajeReal?.id) !== (conductorViajeActivo?.id) || (viajeReal?.estado) !== (conductorViajeActivo?.estado)) {
        evaluarViajeConductor(viajeReal, conductorTelefonoActual);
      }
    });
});

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
  //  Auto del conductor en 3D: 4 capas "model" en vez de 1 sola capa
  //  "symbol" con un PNG. Se separan porque el tinte de color de
  //  Mapbox (model-color) no distingue partes de un mismo mesh — si
  //  tiñeramos el auto entero, las ruedas, los vidrios y los faroles
  //  se pintarian tambien. Cada parte vive en su propio archivo .glb
  //  (generados a partir del sedan-sports de Kenney, separando caras
  //  por el color real que muestrean de la textura):
  //    - auto-paint:  SOLO los paneles de carroceria. Unica capa que
  //                   recibe el color elegido por el conductor.
  //    - auto-trim:   vidrios, paragolpes, spoiler. Textura original,
  //                   nunca se tiñe.
  //    - auto-lights: faroles delanteros/traseros. Ambar fijo.
  //    - auto-wheels: ruedas. Negro fijo.
  //  Las 4 comparten la misma fuente GeoJSON (posicion/heading), asi
  //  que se mueven y giran sincronizadas. Arrancan vacias: solo se
  //  llenan cuando hay un viaje activo con conductor.
  // ==================================================================
  map.addModel('auto-paint-modelo', '/models/sedan-sports-paint.glb');
  map.addModel('auto-trim-modelo', '/models/sedan-sports-trim.glb');
  map.addModel('auto-lights-modelo', '/models/sedan-sports-lights.glb');
  map.addModel('auto-wheels-modelo', '/models/sedan-sports-wheels.glb');

  map.addSource('auto-conductor', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Sombra proyectada debajo del auto: sin esto el auto se ve "flotando"
  // sin contacto con la calle.
  map.addLayer({
    id: 'auto-conductor-sombra',
    type: 'circle',
    source: 'auto-conductor',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 5, 16, 11, 19, 17],
      'circle-color': '#000',
      'circle-opacity': 0.22,
      'circle-blur': 0.7,
      'circle-translate': [0, 2],
    },
  });

  // Escala exagerada a proposito (no realista): a mayor zoom-out, mas
  // grande en proporcion, para que el auto se siga viendo bien aunque
  // el mapa este alejado — el tamaño real se pierde de vista mucho
  // antes que un icono 2D tradicional. model-scale espera un vector
  // [x,y,z], asi que interpolamos entre vectores literales, no un
  // numero suelto.
  const AUTO_MODEL_SCALE = [
    'interpolate', ['linear'], ['zoom'],
    12, ['literal', [42, 42, 42]],
    14, ['literal', [24, 24, 24]],
    16, ['literal', [13, 13, 13]],
    19, ['literal', [5, 5, 5]],
  ];

  // FIX auto "de cola": el .glb (sedan-sports de Kenney) tiene el frente
  // modelado hacia el eje opuesto al que espera calcularRumbo (0=Norte,
  // sentido horario), asi que el heading crudo lo deja mirando para
  // atras. Offset fijo de 180 grados para compensar. Si despues de
  // probarlo en el mapa el auto sigue girado (aunque ya no "de cola"),
  // probar 90 o -90 aca antes que nada — es la unica constante que hay
  // que tocar, las 4 capas la reutilizan.
  const AUTO_MODEL_ROTATION_OFFSET = 180;
  const AUTO_MODEL_ROTATION = [0, 0, ['+', ['get', 'heading'], AUTO_MODEL_ROTATION_OFFSET]];

  map.addLayer({
    id: 'auto-wheels',
    type: 'model',
    source: 'auto-conductor',
    layout: { 'model-id': 'auto-wheels-modelo' },
    paint: {
      'model-rotation': AUTO_MODEL_ROTATION,
      'model-scale': AUTO_MODEL_SCALE,
      'model-color-mix-intensity': 0,
      'model-cast-shadows': true,
    },
  });

  map.addLayer({
    id: 'auto-trim',
    type: 'model',
    source: 'auto-conductor',
    layout: { 'model-id': 'auto-trim-modelo' },
    paint: {
      'model-rotation': AUTO_MODEL_ROTATION,
      'model-scale': AUTO_MODEL_SCALE,
      'model-color-mix-intensity': 0,
      'model-cast-shadows': true,
    },
  });

  map.addLayer({
    id: 'auto-lights',
    type: 'model',
    source: 'auto-conductor',
    layout: { 'model-id': 'auto-lights-modelo' },
    paint: {
      'model-rotation': AUTO_MODEL_ROTATION,
      'model-scale': AUTO_MODEL_SCALE,
      'model-color-mix-intensity': 0,
      'model-cast-shadows': true,
    },
  });

  map.addLayer({
    id: 'auto-paint',
    type: 'model',
    source: 'auto-conductor',
    layout: { 'model-id': 'auto-paint-modelo' },
    paint: {
      'model-rotation': AUTO_MODEL_ROTATION,
      'model-scale': AUTO_MODEL_SCALE,
      'model-color': ['get', 'colorHex'],
      'model-color-mix-intensity': 1,
      'model-cast-shadows': true,
    },
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
let colorConductorSeguido = COLOR_AUTO_DEFAULT;

const ESTADOS_VIAJE_CON_AUTO_VISIBLE = ['conductor_asignado', 'en_camino', 'en_viaje'];

// Punto central: decide si el auto del conductor debe estar visible en el
// mapa segun el viaje activo del pasajero. Llamar siempre despues de
// cualquier cambio a viajeActivoPasajero.
function sincronizarCapaAutoConductor() {
  const telefono = viajeActivoPasajero?.conductor_telefono;
  const activo = Boolean(telefono) && ESTADOS_VIAJE_CON_AUTO_VISIBLE.includes(viajeActivoPasajero.estado);

  if (activo) {
    const colorTexto = viajeActivoPasajero?.color_auto_conductor;
    colorConductorSeguido = COLORES_AUTO[colorTexto] || COLOR_AUTO_DEFAULT;
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
  let mejorIndice = -1;
  for (let i = 0; i < coordenadas.length - 1; i++) {
    const candidato = proyectarEnSegmento(lat, lng, coordenadas[i], coordenadas[i + 1]);
    if (!mejor || candidato.distanciaMetros < mejor.distanciaMetros) {
      mejor = candidato;
      mejorIndice = i;
    }
  }
  if (mejor) mejor.indiceSegmento = mejorIndice;

  if (!mejor || mejor.distanciaMetros > 60) return null;
  return mejor;
}

// ==================================================================
//  Borra visualmente el tramo ya recorrido de la linea de ruta (capas
//  'ruta-glow'/'ruta-linea'), dejando solo lo que falta por delante del
//  auto. Solo toca el source "ruta" — los pines de origen/destino/
//  paradas viven en sources aparte, asi que nunca se ven afectados.
//  Sirve tanto para el seguimiento con GPS real (aplicarNuevaPosicionConductor)
//  como para las simulaciones (simAutoIniciar, devSimularRecorrido), que
//  le pasan el indice de segmento por sus propios medios.
// ==================================================================
function dibujarRutaRestante(coordenadas, indiceSegmento, lat, lng) {
  if (!map.getSource('ruta') || !coordenadas) return;

  const restante = [[lng, lat], ...coordenadas.slice(indiceSegmento + 1)];

  if (restante.length < 2) {
    // Ya no queda nada por delante (llegó): no dejar una linea de 1 punto.
    map.getSource('ruta').setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  map.getSource('ruta').setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: restante },
  });
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
      properties: { heading, colorHex: colorConductorSeguido },
    }],
  });
  posicionConductor = { lat, lng, heading };
}

// Anima el icono del auto desde su posicion actual en pantalla hasta la
// nueva posicion objetivo, en vez de saltar de golpe. La duracion (2.2s)
// queda un poco por debajo del intervalo tipico entre fixes de GPS (3s)
// para que la animacion siempre termine antes de que llegue el proximo.
// Guarda cuándo llegó la última actualización, para calcular cuánto tardó
// realmente entre una y otra (ver FIX debajo).
let ultimaLlegadaFixMs = null;

function animarAutoHacia(latDestino, lngDestino, headingDestino) {
  if (animacionAutoFrameId !== null) {
    cancelAnimationFrame(animacionAutoFrameId);
    animacionAutoFrameId = null;
  }

  const desde = posicionAutoMostrada || { lat: latDestino, lng: lngDestino, heading: headingDestino };

  // FIX: antes la duracion era un numero fijo (2200ms), pensado para el
  // intervalo real de GPS (~3s). El problema es que la simulacion del
  // panel de dev manda actualizaciones mucho mas seguido (cada 350ms) —
  // como cada animacion tardaba 2200ms en llegar a destino, nunca
  // alcanzaba a terminar antes de que llegara el siguiente punto, y
  // quedaba persiguiendo un blanco que siempre estaba mas adelante. Ese
  // atraso constante "redondea" las esquinas de la ruta en vez de
  // doblarlas en angulo recto, dando la sensacion de que el auto corta
  // camino en las curvas. Ahora la duracion se calcula segun cuanto
  // tiempo paso realmente desde la ultima actualizacion (con un piso de
  // 150ms para que no se vea a los saltos, y un techo de 2200ms para no
  // animar de mas si las actualizaciones vienen muy espaciadas), asi la
  // animacion siempre llega a horario para el siguiente punto, sea GPS
  // real (cada ~3s) o la simulacion rapida del panel de dev (cada 350ms).
  const ahoraMs = performance.now();
  const intervaloReal = ultimaLlegadaFixMs != null ? ahoraMs - ultimaLlegadaFixMs : 2200;
  const duracion = Math.min(2200, Math.max(150, intervaloReal * 0.9));
  ultimaLlegadaFixMs = ahoraMs;

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
  if (!fix || fix.lat == null || fix.lng == null) {
    return;
  }

  // FIX: cuando la simulacion local (simAutoIniciar) esta corriendo para
  // el mismo telefono que esta pestaña sigue, esta funcion tambien se
  // disparaba por el eco de Realtime (la simulacion escribe en Supabase
  // 1 vez por segundo para que otros dispositivos reales la vean) —
  // asi que dos animaciones distintas terminaban peleando por la misma
  // posicion del auto: la simulacion local (fluida, 60 veces por
  // segundo) contra esta funcion tratando de "suavizar" hacia un dato
  // que en realidad ya estaba desactualizado en el momento de llegar,
  // dando la sensacion de que el auto frena/acelera/retrocede. Mientras
  // la simulacion local este activa para este mismo telefono, ella es
  // la unica fuente de verdad visual — se ignora el eco de Realtime.
  if (simAutoTelefono && telefonoConductorSeguido === simAutoTelefono) {
    return;
  }

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

  if (proyeccion) {
    // Sigue sobre la ruta calculada: borramos el tramo ya recorrido.
    dibujarRutaRestante(rutaGeometriaActual, proyeccion.indiceSegmento, latObjetivo, lngObjetivo);
  } else if (rutaGeometriaActual) {
    // Habia una ruta pero el conductor se desvio (tomo otro camino):
    // pedimos una ruta nueva desde donde esta ahora hasta el mismo
    // destino/paradas que faltan, en vez de dejar la linea vieja
    // dibujada sobre un camino que ya no esta siguiendo.
    recalcularRutaSiDesviado(fix);
  }
}

// Waypoints [{lat,lng}, ...] de la ruta que se esta siguiendo ahora mismo
// (origen real + paradas/destino que faltan), para poder recalcular sin
// perder de vista a donde tiene que llegar el conductor.
let puntosRutaSeguidaActual = null;
let recalculandoRutaSeguida = false;

async function recalcularRutaSiDesviado(fix) {
  if (!puntosRutaSeguidaActual || puntosRutaSeguidaActual.length < 2 || recalculandoRutaSeguida) return;
  recalculandoRutaSeguida = true;
  try {
    const puntosRestantes = puntosRutaSeguidaActual.slice(1);
    const ruta = await getRuta([{ lat: fix.lat, lng: fix.lng }, ...puntosRestantes]);
    if (ruta && map.getSource('ruta')) {
      map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
      rutaGeometriaActual = ruta.geometry?.coordinates || null;
      puntosRutaSeguidaActual = [{ lat: fix.lat, lng: fix.lng }, ...puntosRestantes];
    }
  } catch (err) {
    console.error('[Movi] Error recalculando ruta por desvio:', err);
  } finally {
    recalculandoRutaSeguida = false;
  }
}

function iniciarSeguimientoPosicionConductor(telefono) {
  if (telefonoConductorSeguido === telefono && canalPosicionConductor) {
    return;
  }

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
  puntosRutaSeguidaActual = null;
  ultimaLlegadaFixMs = null;

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

if (rol === 'conductor') {
  marcadorOrigen.setDraggable(false);
}

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
  paradasFloatBar.classList.toggle('show', !!destinoActual);
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
  // FIX: no dejar cambiar destino ni agregar parada si ya hay un viaje
  // pedido y en curso. Antes esta funcion pisaba destinoActual/paradas
  // y recalculaba la ruta igual aunque el sheet de pedir viaje ya
  // estuviera oculto (p. ej. tocando el mapa con el chofer en camino
  // al origen) — el pasajero terminaba cambiando de destino sin que se
  // le cobrara ningun recargo, porque esto nunca tocaba el registro
  // real del viaje en Supabase.
  const estadoViajeActivo = viajeActivoPasajero?.estado;
  if (estadoViajeActivo && estadoViajeActivo !== 'cancelado' && estadoViajeActivo !== 'finalizado') {
    mostrarToast('No podés cambiar el destino con el viaje ya en curso', '🚫');
    modoBusqueda = null;
    return;
  }

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
//
//  FORMULA AJUSTADA A TARIFAS REALES DE VIEDMA (decreto municipal
//  vigente desde 1/7/2026): bajada de bandera diurna $2.668, ficha
//  ~$168 cada 100m (≈ $1.680/km). La formula vieja (2000 + km*200 +
//  min*80) quedaba muy por debajo de la tarifa real de taxi/remis de
//  la ciudad — un viaje de 2km terminaba costando ~$2.880 en vez de
//  los ~$6.000 que cobraría un taxi real. Se corrigio para que el
//  precio de Movi sea representativo de un valor de mercado real.
//
//  MOVI ENVIOS: mismo recorrido, pero con base y tarifa por km mas
//  bajas (un paquete no necesita el mismo nivel de cuidado/tiempo que
//  un pasajero, y suele ser mas rapido/directo), sin componente por
//  minuto (no importa si hay trafico para el paquete en si).
// ==================================================================
const PRECIO_BASE = 2700;
const PRECIO_POR_KM = 1700;
const PRECIO_POR_MINUTO = 150;

function esHorarioNocturno() {
  const hora = new Date().getHours();
  return hora >= 21 || hora < 6;
}

const ENVIO_BASE = 1500;
const ENVIO_POR_KM = 1100;

let tipoViajeSeleccionado = 'normal'; // 'normal' | 'envios'

// ==================================================================
//  Sistema de ofertas/descuentos. precioNormalSinDescuento se guarda
//  cada vez que recalcularRuta corre, para que aplicarDescuento() tenga
//  siempre la base correcta sin tener que recalcular la ruta de nuevo.
//  ofertaActual es la fila de la tabla "ofertas" ya validada (o null).
// ==================================================================
let precioNormalSinDescuento = 0;
let precioEnvioSinDescuento = 0;
let ofertaActual = null;

function calcularDescuento(precioBase, oferta) {
  if (oferta.tipo === 'porcentaje') return Math.round(precioBase * oferta.valor / 100);
  return Math.min(oferta.valor, precioBase);
}

// Pinta ride-price-normal y ride-price-envios a partir de los precios
// sin descuento guardados arriba, aplicando ofertaActual si hay una.
// La llaman recalcularRuta() (cuando cambia la ruta) y aplicarDescuento()
// / limpiarDescuento() (cuando cambia el código), asi el precio mostrado
// siempre esta sincronizado con el ultimo estado de ambas cosas.
function pintarPrecios() {
  const descuentoNormal = ofertaActual ? calcularDescuento(precioNormalSinDescuento, ofertaActual) : 0;
  const precioFinalNormal = precioNormalSinDescuento - descuentoNormal;
  document.getElementById('ride-price-normal').textContent = `$ ${precioFinalNormal.toLocaleString('es-AR')}`;

  const elPrecioEnvio = document.getElementById('ride-price-envios');
  if (elPrecioEnvio) elPrecioEnvio.textContent = `$ ${precioEnvioSinDescuento.toLocaleString('es-AR')}`;

  const detalleEl = document.getElementById('descuento-detalle');
  if (detalleEl) {
    if (ofertaActual && descuentoNormal > 0) {
      detalleEl.textContent = `Descuento de $${descuentoNormal.toLocaleString('es-AR')} aplicado (${ofertaActual.codigo})`;
      detalleEl.style.display = 'block';
    } else {
      detalleEl.style.display = 'none';
    }
  }
}

async function recalcularRuta() {
  if (!destinoActual || paradas.length === 0) return;

  const puntos = [origenActual, ...paradas.map((p) => ({ lat: p.lat, lng: p.lng }))];
  const ruta = await getRuta(puntos);
  if (!ruta) return;

  const minutosTexto = Math.round(ruta.minutos);
  document.getElementById('ride-sub-normal').textContent = `${minutosTexto} min · ${ruta.km.toFixed(1)} km`;

  const nocturno = esHorarioNocturno();
  const multiplicador = nocturno ? 1.3 : 1;

  precioNormalSinDescuento = Math.round((PRECIO_BASE + ruta.km * PRECIO_POR_KM + ruta.minutos * PRECIO_POR_MINUTO) * multiplicador);
  precioEnvioSinDescuento = Math.round(ENVIO_BASE + ruta.km * ENVIO_POR_KM);
  pintarPrecios();

  const badgeEl = document.getElementById('recargo-nocturno');
  if (badgeEl) badgeEl.style.display = nocturno ? 'inline' : 'none';

  aplicarEstiloRuta('viaje');
  if (map.getSource('ruta')) {
    map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
  }
  rutaGeometriaActual = ruta.geometry?.coordinates || null;

  // Iniciar (o reanudar) la animación del glow ahora que hay ruta
  window._iniciarAnimacionGlow();
}

// ==================================================================
//  Ofertas: validar codigo contra Supabase y aplicarlo al precio.
// ==================================================================

// true si el pasajero (por telefono) todavia no tiene ningun viaje que
// no haya sido cancelado. Si no hay usuario logueado, se trata como
// "primer viaje" para no bloquear la promo antes del login.
async function verificarPrimerViaje(telefono) {
  if (!telefono) return true;

  const { data, error } = await supabase
    .from('viajes')
    .select('id')
    .eq('telefono_pasajero', telefono)
    .neq('estado', 'cancelado')
    .limit(1);

  if (error) {
    console.error('[Movi] Error verificando primer viaje:', error);
    return false;
  }
  return !data || data.length === 0;
}

function mostrarErrorDescuento(msg) {
  const msgEl = document.getElementById('descuento-msg');
  if (!msgEl) return;
  msgEl.textContent = msg;
  msgEl.style.display = 'block';
  msgEl.classList.add('error');
}

function limpiarDescuento() {
  ofertaActual = null;
  const msgEl = document.getElementById('descuento-msg');
  if (msgEl) {
    msgEl.textContent = '';
    msgEl.style.display = 'none';
    msgEl.classList.remove('error');
  }
  pintarPrecios();
}

async function aplicarDescuento(codigoIngresado) {
  const codigo = (codigoIngresado || '').trim().toUpperCase();
  if (!codigo) {
    mostrarErrorDescuento('Ingresá un código');
    return;
  }

  const { data: oferta, error } = await supabase
    .from('ofertas')
    .select('*')
    .eq('codigo', codigo)
    .eq('activo', true)
    .maybeSingle();

  if (error) {
    console.error('[Movi] Error buscando oferta:', error);
    mostrarErrorDescuento('No se pudo validar el código, intentá de nuevo');
    return;
  }

  if (!oferta) {
    mostrarErrorDescuento('Código inválido');
    return;
  }

  if (oferta.fecha_vencimiento && new Date(oferta.fecha_vencimiento) < new Date()) {
    mostrarErrorDescuento('Este código venció');
    return;
  }

  if (oferta.usos_maximos != null && oferta.usos_actuales >= oferta.usos_maximos) {
    mostrarErrorDescuento('Este código ya alcanzó el máximo de usos');
    return;
  }

  if (oferta.solo_primer_viaje) {
    const usuarioActual = cargarUsuario();
    const telefonoPasajero = usuarioActual ? usuarioActual.telefono : '';
    const esPrimerViaje = await verificarPrimerViaje(telefonoPasajero);
    if (!esPrimerViaje) {
      mostrarErrorDescuento('Este código es solo para tu primer viaje');
      return;
    }
  }

  ofertaActual = oferta;
  const msgEl = document.getElementById('descuento-msg');
  if (msgEl) {
    msgEl.textContent = '¡Código aplicado! 🎉';
    msgEl.style.display = 'block';
    msgEl.classList.remove('error');
  }
  pintarPrecios();
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
    tipoViajeSeleccionado = row.dataset.ride || 'normal';
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

btnModificarDestino.addEventListener('click', async () => {
  if (localStorage.getItem('rol') === 'conductor') return;

  if (viajeActivoPasajero !== null && viajeActivoPasajero.estado !== 'pendiente') {
    const confirmar = await mostrarConfirm(
      '¿Modificar el destino? El precio del viaje se va a recalcular.',
      'Modificar',
      'Cancelar'
    );
    if (!confirmar) return;
  }

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

// ---- Código de descuento ----
const codigoDescuentoInput = document.getElementById('codigo-descuento');
const btnAplicarCodigo = document.getElementById('btn-aplicar-codigo');

if (btnAplicarCodigo && codigoDescuentoInput) {
  btnAplicarCodigo.addEventListener('click', () => aplicarDescuento(codigoDescuentoInput.value));

  codigoDescuentoInput.addEventListener('input', () => {
    if (codigoDescuentoInput.value.trim() === '' && ofertaActual) {
      limpiarDescuento();
    }
  });
}

document.getElementById('btn-pedir-viaje').addEventListener('click', async () => {
  if (!destinoActual) return;

  console.log('[Movi] Iniciando guardado de viaje en Supabase...');

  buscandoOverlay.classList.add('show');
  requestAnimationFrame(() => buscandoOverlay.classList.add('visible'));
  actualizarControlesDevEnViaje();

  const idPrecio = tipoViajeSeleccionado === 'envios' ? 'ride-price-envios' : 'ride-price-normal';
  const precioTexto = document.getElementById(idPrecio).textContent;
  const precio = Number(precioTexto.replace(/[^0-9]/g, '')) || null;

  const usuarioActual = cargarUsuario();
  const telefonoPasajero = usuarioActual ? usuarioActual.telefono : '';

  // Si hay una oferta aplicada y el viaje es de tipo "normal" (el
  // descuento no aplica a envíos), calculamos cuanto se descontó para
  // dejarlo registrado en el viaje.
  const codigoOferta = ofertaActual && tipoViajeSeleccionado === 'normal' ? ofertaActual.codigo : null;
  const descuentoAplicado = codigoOferta
    ? calcularDescuento(precioNormalSinDescuento, ofertaActual)
    : null;

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
      codigo_oferta: codigoOferta,
      descuento_aplicado: descuentoAplicado,
    })
    .select()
    .single();

  if (error) {
    console.error('[Movi] Error creando viaje en Supabase:', error);
    buscandoOverlay.classList.remove('show', 'visible');
    return;
  }

  // Si se uso un codigo, sumamos 1 a usos_actuales recien ahora que el
  // viaje se creo con exito (no antes, para no descontar el cupo si el
  // insert fallara). No es atomico (podria haber una carrera si dos
  // personas usan el mismo codigo al mismo milisegundo), pero para el
  // volumen de Movi hoy es una ventana aceptable.
  if (codigoOferta && ofertaActual) {
    const { error: errorOferta } = await supabase
      .from('ofertas')
      .update({ usos_actuales: ofertaActual.usos_actuales + 1 })
      .eq('id', ofertaActual.id);
    if (errorOferta) {
      console.error('[Movi] Error actualizando usos_actuales de la oferta:', errorOferta);
    }
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

  // Nos quedamos escuchando este viaje durante TODO su ciclo de vida (no
  // solo hasta que se asigne conductor) — antes el canal se cerraba apenas
  // se asignaba, asi que ni con un conductor real ni con la simulacion se
  // iba a enterar nunca de "llego"/"en_viaje"/"finalizado" mas adelante.
  if (canalEsperaAsignacion) {
    supabase.removeChannel(canalEsperaAsignacion);
    canalEsperaAsignacion = null;
  }

  canalEsperaAsignacion = supabase
    .channel(`viaje-activo-pasajero-${viaje.id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'viajes', filter: `id=eq.${viaje.id}` },
      (payload) => procesarActualizacionViajePasajero(payload.new),
    )
    .subscribe();

  // FIX: condicion de carrera — si el conductor acepta el viaje en el
  // instante justo en que esta suscripcion todavia se estaba terminando
  // de establecer (el .subscribe() de arriba es asincronico "por dentro":
  // toma un ratito conectar el websocket de verdad), el pasajero se podia
  // perder ese aviso para siempre, quedando en "Buscando conductor..."
  // sin que nada le llegara nunca (el conductor, del otro lado, no
  // depende de este aviso para avanzar, por eso a el si le funcionaba).
  // Como red de seguridad, apenas se pide la suscripcion, tambien
  // consultamos una vez de una el estado actual real del viaje — si ya
  // habia cambiado antes de que la suscripcion quedara lista, lo
  // agarramos igual aca.
  supabase
    .from('viajes')
    .select('*')
    .eq('id', viaje.id)
    .single()
    .then(({ data: viajeActual, error: errorViajeActual }) => {
      if (errorViajeActual || !viajeActual) return;
      if (viajeActual.estado !== 'pendiente') {
        procesarActualizacionViajePasajero(viajeActual);
      }
    });
});

// ==================================================================
//  Isla flotante de ETA (arriba del mapa, estilo Dynamic Island):
//  muestra cuantos minutos reales tarda el conductor en llegar. Se
//  actualiza cada vez que llega un cambio del viaje (incluido el ETA
//  recalculado en dibujarRutaConductorHaciaOrigen).
// ==================================================================
const etaIsland = document.getElementById('eta-island');
const etaIslandTexto = document.getElementById('eta-island-texto');

function actualizarIslaEta(viaje) {
  const visible = ['conductor_asignado', 'en_camino', 'llegó'].includes(viaje.estado);
  if (!visible) {
    etaIsland.classList.remove('show');
    return;
  }
  etaIslandTexto.textContent = viaje.estado === 'llegó'
    ? 'Tu conductor llegó 📍'
    : (viaje.eta_minutos != null ? `Tu conductor llega en ${viaje.eta_minutos} min` : 'Tu conductor está en camino');
  etaIsland.classList.add('show');
}

// Toda la logica de reaccionar a un cambio de estado del viaje del
// pasajero, en una funcion aparte para poder llamarla tanto desde el
// evento de Realtime como desde el chequeo manual de respaldo (arriba, y
// tambien el listener de "volvi a la pestaña" mas abajo).
function procesarActualizacionViajePasajero(actualizado) {
  const estadoAnterior = viajeActivoPasajero?.estado;
  viajeActivoPasajero = actualizado;
  sincronizarCapaAutoConductor();
  actualizarIslaEta(actualizado);

  const estadoViaje = actualizado.estado;
  if (['conductor_asignado', 'en_camino', 'en_viaje'].includes(estadoViaje)) {
    marcadorOrigen.setDraggable(false);
  } else if (estadoViaje === 'finalizado' || estadoViaje === 'cancelado' || viajeActivoPasajero === null) {
    marcadorOrigen.setDraggable(true);
  }

  if (actualizado.estado === 'conductor_asignado' && actualizado.conductor_telefono && estadoAnterior !== 'conductor_asignado') {
    buscandoOverlay.classList.remove('show', 'visible');
    sheet.style.display = 'none';
    driverSheet.style.display = 'block';
    aplicarDatosConductorEnSheet(actualizado);
    actualizarControlesDevEnViaje();
    mostrarToast(`${actualizado.nombre_conductor || 'Tu conductor'} está en camino 🚗`, '🚗');

    // FIX: esto se disparaba solo con solo tener es_admin=true guardado
    // en el celular (por ejemplo, de una prueba vieja con admin/admin),
    // tapando el GPS real del conductor con un auto de mentira cerca del
    // punto de partida del pasajero — sin avisar que era una simulacion.
    // Ahora la simulacion de acercamiento solo arranca si se toca a
    // proposito el boton de desarrollador (ver devBtnSimularOrigen).
  } else if (actualizado.estado === 'llegó' && estadoAnterior !== 'llegó') {
    mostrarToast('Tu conductor llegó al punto de encuentro 📍', '📍');
    actualizarControlesDevEnViaje();
  } else if (actualizado.estado === 'en_viaje' && estadoAnterior !== 'en_viaje') {
    mostrarToast('Viaje iniciado — ¡buen viaje! ▶️', '▶️');
    actualizarControlesDevEnViaje();
  } else if (actualizado.estado === 'cancelado' && estadoAnterior !== 'cancelado') {
    const tarifa = Number(actualizado.tarifa_cancelacion) || 0;
    mostrarToast(
      tarifa > 0
        ? `Viaje cancelado — se cobró $${tarifa.toLocaleString('es-AR')} por el tiempo del conductor ❌`
        : 'El viaje fue cancelado ❌',
      '❌',
    );
    buscandoOverlay.classList.remove('show', 'visible');
    driverSheet.style.display = 'none';
    sheet.style.display = 'block';
    viajeActivoPasajero = null;
    simAutoDetener();
    sincronizarCapaAutoConductor();
    actualizarControlesDevEnViaje();
    if (canalEsperaAsignacion) {
      supabase.removeChannel(canalEsperaAsignacion);
      canalEsperaAsignacion = null;
    }
  } else if (actualizado.estado === 'finalizado' && estadoAnterior !== 'finalizado') {
    mostrarToast('Viaje finalizado ✅', '✅');
    driverSheet.style.display = 'none';
    resetPaymentSheet();
    paymentSheet.style.display = 'block';
    paymentSheet.classList.remove('collapsed');
    simAutoDetener();
    if (canalEsperaAsignacion) {
      supabase.removeChannel(canalEsperaAsignacion);
      canalEsperaAsignacion = null;
    }
  } else {
    actualizarControlesDevEnViaje();
  }
}

// FIX: si el celular se puso en reposo (pantalla bloqueada) mientras se
// esperaba, el navegador puede cortar la conexion en tiempo real sin
// avisar. Cuando la pestaña vuelve a estar visible, chequeamos a mano el
// estado real del viaje activo por si nos perdimos algun cambio mientras
// tanto — asi nunca queda la pantalla "colgada" esperando un aviso que
// ya paso.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!viajeActivoPasajero || !viajeActivoPasajero.id) return;

  supabase
    .from('viajes')
    .select('*')
    .eq('id', viajeActivoPasajero.id)
    .single()
    .then(({ data: viajeActual, error }) => {
      if (error || !viajeActual) return;
      if (viajeActual.estado !== viajeActivoPasajero.estado) {
        procesarActualizacionViajePasajero(viajeActual);
      }
    });
});



document.getElementById('btn-cancelar-busqueda').addEventListener('click', async () => {
  buscandoOverlay.classList.remove('show', 'visible');
  actualizarControlesDevEnViaje();

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
  marcadorOrigen.setDraggable(true);
});

document.getElementById('btn-cancelar-viaje').addEventListener('click', async () => {
  if (!viajeActivoPasajero) {
    driverSheet.style.display = 'none';
    sheet.style.display = 'block';
    simAutoDetener();
    actualizarControlesDevEnViaje();
    return;
  }

  // Este boton solo se ve una vez que ya hay conductor asignado (driver-sheet),
  // asi que cancelar desde aca siempre implica que el conductor ya invirtio
  // tiempo yendo hacia el pasajero — se cobra un porcentaje del precio
  // estimado como compensacion, para que cancelar sin aviso no le haga
  // perder el viaje gratis al conductor.
  const precio = Number(viajeActivoPasajero.precio) || 0;
  const tarifaCancelacion = Math.round(precio * 0.30);

  const confirmar = await mostrarConfirm(
    `Cancelar ahora tiene un cargo del 30% del viaje ($${tarifaCancelacion.toLocaleString('es-AR')}), por el tiempo que ya perdió el conductor viniendo hacia vos.\n\n¿Confirmás la cancelación?`,
    'Sí, cancelar',
    'Volver',
  );
  if (!confirmar) return;

  const { error } = await supabase
    .from('viajes')
    .update({ estado: 'cancelado', tarifa_cancelacion: tarifaCancelacion })
    .eq('id', viajeActivoPasajero.id);

  if (error) {
    console.error('[Movi] Error cancelando el viaje:', error);
    mostrarToast('No se pudo cancelar, intentá de nuevo ❌', '❌');
    return;
  }

  // El resto (ocultar driver-sheet, mostrar el mapa de nuevo, avisar con
  // el toast) lo dispara solo procesarActualizacionViajePasajero() apenas
  // llegue el eco de este mismo cambio por Realtime — asi hay un solo
  // lugar en el codigo que decide como reaccionar a un viaje cancelado,
  // sea que lo cancele el pasajero, el conductor, o el sistema (10 min).
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
function hacerArrastrable(sheetEl, linkedEl) {
  const handle = sheetEl.querySelector('.sheet-handle-zone');
  if (!handle) return;

  let arrastrando = false;
  let startY = 0;
  let startTransform = 0;
  let startTime = 0;

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
    startTime = performance.now();
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
    if (linkedEl) linkedEl.style.transform = `translateY(${nuevoY}px)`;
  });

  function terminarArrastre(e) {
    if (!arrastrando) return;
    arrastrando = false;
    sheetEl.classList.remove('dragging');
    const delta = e.clientY - startY;
    const elapsed = Math.max(1, performance.now() - startTime);
    // Velocidad en px/ms: un swipe rapido y corto debe colapsar/expandir
    // igual que uno lento y largo, aunque no llegue al umbral de distancia.
    const velocidad = delta / elapsed;
    const estabaColapsado = sheetEl.dataset.estabaColapsado === 'true';

    if (estabaColapsado) {
      // Si estaba colapsado y arrastro mas de 40px hacia arriba, o solto
      // con velocidad hacia arriba, expande
      if (delta < -40 || velocidad < -0.5) {
        sheetEl.classList.remove('collapsed');
      } else {
        sheetEl.classList.add('collapsed');
      }
    } else {
      // Si estaba expandido y arrastro mas de 60px hacia abajo, o solto
      // con velocidad hacia abajo, colapsa
      if (delta > 60 || velocidad > 0.5) {
        sheetEl.classList.add('collapsed');
      } else {
        sheetEl.classList.remove('collapsed');
      }
    }
    sheetEl.style.transform = '';
    if (linkedEl) linkedEl.style.transform = '';
  }

  handle.addEventListener('pointerup', terminarArrastre);
  handle.addEventListener('pointercancel', terminarArrastre);
}

hacerArrastrable(sheet, paradasFloatBar);
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

// Cabecera de perfil del menu: tocarla lleva directo al drawer de perfil.
document.getElementById('menu-profile-card').addEventListener('click', () => abrirDrawer(perfilDrawer));

// TODO: cuando exista login, leer aca la direccion guardada real del
// usuario para los items 'casa' / 'trabajo' del drawer de perfil, en vez
// de solo loguear el click.
document.querySelectorAll('.drawer-item, .drawer [data-item]').forEach((item) => {
  item.addEventListener('click', () => {
    const accion = item.dataset.item;
    console.log('[Movi] Tocaste el item del drawer:', accion);
    cerrarDrawers();

    if (accion === 'cerrar-sesion') {
      cerrarSesion();
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

// ==================================================================
//  Historial HÍBRIDO: Supabase sigue siendo la fuente real (para que
//  el historial no se pierda si cambian de celular, y para que vos
//  como dueño de la app puedas verlo/auditarlo), pero ademas se guarda
//  una copia en localStorage de cada dispositivo — asi el historial
//  aparece INSTANTANEO al abrir la pantalla (sin esperar la red), y
//  sigue funcionando para lectura aunque el celular se quede sin
//  internet un rato. Cada vez que se trae una version fresca de
//  Supabase, se actualiza la copia local.
// ==================================================================
function claveCacheHistorial(rol, telefono) {
  return `historial_cache_${rol}_${telefono}`;
}

function guardarHistorialEnCache(clave, data, paradasPorViaje) {
  try {
    localStorage.setItem(clave, JSON.stringify({ data, paradasPorViaje, guardadoEn: Date.now() }));
  } catch (e) {
    // localStorage lleno o deshabilitado — no es grave, el historial
    // simplemente no queda cacheado esta vez, sigue funcionando por red.
    console.warn('[Movi] No se pudo cachear el historial localmente:', e);
  }
}

function leerHistorialDeCache(clave) {
  try {
    const crudo = localStorage.getItem(clave);
    if (!crudo) return null;
    return JSON.parse(crudo);
  } catch (e) {
    return null;
  }
}

function renderHistorial(data, paradasPorViaje) {
  if (!data || data.length === 0) {
    historialLista.innerHTML = '<div class="result-empty">Sin viajes todavía</div>';
    return;
  }

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

async function abrirHistorial() {
  historialOverlay.classList.add('show');

  const rolActual = localStorage.getItem('rol');
  let telefonoActual;

  if (rolActual === 'conductor' && conductorTelefonoActual) {
    telefonoActual = conductorTelefonoActual;
  } else {
    const usuario = cargarUsuario();
    if (!usuario) {
      historialLista.innerHTML = '<div class="result-empty">Sin viajes todavía</div>';
      return;
    }
    telefonoActual = usuario.telefono;
  }

  const clave = claveCacheHistorial(rolActual, telefonoActual);

  // 1. Pintamos YA lo que haya en cache local, para que se sienta
  //    instantaneo (si es la primera vez en este dispositivo, no hay
  //    nada todavia y mostramos "Cargando...").
  const cacheado = leerHistorialDeCache(clave);
  if (cacheado) {
    renderHistorial(cacheado.data, cacheado.paradasPorViaje);
  } else {
    historialLista.innerHTML = '<div class="result-empty">Cargando...</div>';
  }

  // 2. Traemos la version real y fresca de Supabase de fondo, y
  //    actualizamos tanto la pantalla como la cache local con eso.
  let query = supabase.from('viajes').select('*').in('estado', ['finalizado', 'cancelado']);
  query = rolActual === 'conductor' && conductorTelefonoActual
    ? query.eq('conductor_telefono', telefonoActual)
    : query.eq('telefono_pasajero', telefonoActual);

  const { data, error } = await query.order('creado_en', { ascending: false }).limit(50);

  if (error) {
    console.error('[Movi] Error trayendo historial:', error);
    // Si ya habia algo en cache, lo dejamos como esta (mejor mostrar
    // datos un poco viejos que un error tapando todo). Si no habia
    // nada, ahi si mostramos el error.
    if (!cacheado) {
      historialLista.innerHTML = '<div class="result-empty">Error cargando el historial</div>';
    }
    return;
  }

  if (!data || data.length === 0) {
    renderHistorial([], {});
    guardarHistorialEnCache(clave, [], {});
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

  renderHistorial(data, paradasPorViaje);
  guardarHistorialEnCache(clave, data, paradasPorViaje);
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
  const total = viajeActivoPasajero?.precio
    ? `$ ${Number(viajeActivoPasajero.precio).toLocaleString('es-AR')}`
    : document.getElementById('ride-price-normal').textContent;

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
      precio: 5800,
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

  // FIX: antes esta pantalla dependia 100% de que Supabase Realtime le
  // devolviera el dato (escribir -> Realtime -> aplicarNuevaPosicionConductor)
  // para pintar cada punto. Con la simulacion mandando puntos cada 350ms,
  // si esa vuelta se demoraba o llegaban varios de golpe, algunos puntos
  // intermedios se perdian en el camino y se veia como un salto/TP. Ahora,
  // si esta misma pestaña ya esta seguionde a este telefono, pintamos el
  // punto de una directo en el mapa (sin esperar el viaje de ida y vuelta),
  // y ADEMAS seguimos escribiendo en Supabase como antes, para que
  // cualquier otro dispositivo real mirando a este conductor lo siga
  // recibiendo por Realtime normalmente.
  if (telefonoConductorSeguido === telefono) {
    aplicarNuevaPosicionConductor({ lat, lng, heading });
  }

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
//  2c. SIMULAR RECORRIDO AUTOMÁTICO — reconstruido de cero.
//
//  Version anterior (con problemas): caminaba por los puntos crudos de
//  la geometria de la ruta a un INTERVALO DE TIEMPO fijo. El problema de
//  fondo: Mapbox no reparte esos puntos de forma pareja — pone muchos
//  puntos juntos en las curvas y pocos en los tramos rectos (mas largos).
//  Visitarlos todos al mismo ritmo (cada X ms) hacia que el auto "volara"
//  en las rectas (poca distancia entre puntos pero mismo tiempo entre
//  ellos que en una curva) y se arrastrara en las curvas — una velocidad
//  completamente irreal y que además variaba todo el tiempo.
//
//  Version nueva: se calcula la DISTANCIA REAL acumulada de toda la ruta
//  (sumando la distancia entre cada par de puntos consecutivos), y se
//  avanza sobre esa distancia a una VELOCIDAD CONSTANTE (metros/segundo,
//  configurable abajo) usando requestAnimationFrame — en cada frame se
//  calcula "cuantos metros deberiamos haber recorrido a esta velocidad
//  desde que arrancamos" y se interpola la posicion exacta sobre el
//  segmento de la ruta que corresponda a esa distancia. Esto da una
//  animacion perfectamente fluida y a un ritmo realista (tipo auto de
//  ciudad) sin importar como este repartida la geometria de la ruta.
// ==================================================================
const devBtnSimularOrigen = document.getElementById('dev-btn-simular-origen');
const devBtnSimularDestino = document.getElementById('dev-btn-simular-destino');
const devBtnDetenerSimulacion = document.getElementById('dev-btn-detener-simulacion');
const devFeedbackSimulacion = document.getElementById('dev-feedback-simulacion');

// Punto de partida ficticio, unas cuadras al sur del origen de prueba, para
// simular que el conductor viene acercandose desde algun lado.
const TEST_PUNTO_PARTIDA = { lat: -40.8175, lng: -62.9955 };

const VELOCIDAD_SIMULACION_MS = 11;          // ~40 km/h, velocidad tipica de ciudad
const INTERVALO_ESCRITURA_SUPABASE_MS = 1000; // cada cuanto avisamos a otros dispositivos reales (no hace falta a 60fps)

// Distancia en metros entre dos puntos [lng,lat]. Aproximacion plana con
// correccion de longitud por latitud (misma formula que ya usa
// proyectarEnSegmento mas arriba) — de sobra de precision a escala de
// una ciudad como Viedma.
function devDistanciaMetros(a, b) {
  const latRef = a[1] * Math.PI / 180;
  const metrosPorGradoLng = METROS_POR_GRADO_LAT_AUTO * Math.cos(latRef);
  const dx = (b[0] - a[0]) * metrosPorGradoLng;
  const dy = (b[1] - a[1]) * METROS_POR_GRADO_LAT_AUTO;
  return Math.hypot(dx, dy);
}

// Tabla de distancia acumulada: acumuladas[i] = cuantos metros hay desde
// el inicio de la ruta hasta el punto coords[i].
function devConstruirTablaDistancias(coords) {
  const acumuladas = [0];
  for (let i = 1; i < coords.length; i++) {
    acumuladas.push(acumuladas[i - 1] + devDistanciaMetros(coords[i - 1], coords[i]));
  }
  return acumuladas;
}

// Dada una distancia recorrida (en metros desde el inicio), encuentra en
// que segmento de la ruta cae y devuelve la posicion exacta interpolada
// (mas el rumbo de ese segmento, para la rotacion del icono).
function devPuntoEnDistancia(coords, acumuladas, distancia) {
  let i = 1;
  while (i < acumuladas.length && acumuladas[i] < distancia) i++;
  if (i >= acumuladas.length) i = acumuladas.length - 1;

  const inicioSegmento = acumuladas[i - 1];
  const largoSegmento = acumuladas[i] - inicioSegmento || 1;
  const t = Math.max(0, Math.min(1, (distancia - inicioSegmento) / largoSegmento));

  const a = coords[i - 1];
  const b = coords[i];
  const lng = a[0] + (b[0] - a[0]) * t;
  const lat = a[1] + (b[1] - a[1]) * t;
  const heading = calcularRumbo({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });

  return { lat, lng, heading, indiceSegmento: i - 1 };
}

// ==================================================================
//  MOTOR GENÉRICO DE SIMULACIÓN — usado tanto por el panel de dev (mas
//  abajo) como por el flujo REAL de "Pedir viaje" cuando quien esta
//  probando es admin (ver btn-pedir-viaje). A diferencia de
//  devSimularRecorrido (que usa coordenadas de prueba fijas), este toma
//  cualquier punto real (origen/paradas/destino que el pasajero eligio
//  de verdad) y ademas permite "saltar" la animacion al final en
//  cualquier momento con simAutoSaltarAlFinal(), ejecutando igual el
//  callback de finalizacion que se le haya pasado.
// ==================================================================
function esAdmin() {
  return localStorage.getItem('es_admin') === 'true';
}

let simAutoFrameId = null;
let simAutoCoords = null;
let simAutoAcumuladas = null;
let simAutoDistanciaTotal = null;
let simAutoTelefono = null;
let simAutoCallbackFinal = null;

function simAutoEscribirSupabase(punto) {
  supabase
    .from('conductores')
    .update({ lat: punto.lat, lng: punto.lng, heading: punto.heading, actualizado_en: new Date().toISOString() })
    .eq('telefono', simAutoTelefono)
    .then(({ error }) => {
      if (error) console.error('[Sim] Error escribiendo posición simulada:', error);
    });
}

function simAutoDetener() {
  if (simAutoFrameId !== null) {
    cancelAnimationFrame(simAutoFrameId);
    simAutoFrameId = null;
  }
  simAutoCoords = null;
  simAutoAcumuladas = null;
  simAutoDistanciaTotal = null;
  simAutoCallbackFinal = null;
}

// Corta la animacion en curso donde este y "teletransporta" al punto
// final de esa etapa, ejecutando el callback que se le haya pasado a
// simAutoIniciar (por ejemplo, marcar el viaje como finalizado). Es el
// botón de "Saltear animación" que ve el admin en pantalla.
function simAutoSaltarAlFinal() {
  if (!simAutoCoords || !simAutoAcumuladas) return;

  const final = devPuntoEnDistancia(simAutoCoords, simAutoAcumuladas, simAutoDistanciaTotal);
  pintarAutoEnMapa(final.lat, final.lng, final.heading);
  dibujarRutaRestante(simAutoCoords, simAutoCoords.length, final.lat, final.lng);
  posicionAutoMostrada = final;
  simAutoEscribirSupabase(final);

  if (simAutoFrameId !== null) {
    cancelAnimationFrame(simAutoFrameId);
    simAutoFrameId = null;
  }

  const callback = simAutoCallbackFinal;
  simAutoCoords = null;
  simAutoAcumuladas = null;
  simAutoDistanciaTotal = null;
  simAutoCallbackFinal = null;

  if (callback) callback();
}

async function simAutoIniciar(puntos, telefono, callbackAlLlegar) {
  simAutoDetener();

  const ruta = await getRuta(puntos);
  if (!ruta || !ruta.geometry?.coordinates?.length) {
    console.error('[Sim] No se pudo calcular la ruta para la simulación automática', puntos);
    return;
  }

  if (map.getSource('ruta')) {
    map.getSource('ruta').setData({ type: 'Feature', properties: {}, geometry: ruta.geometry });
  }
  rutaGeometriaActual = ruta.geometry.coordinates;
  puntosRutaSeguidaActual = puntos;
  window._iniciarAnimacionGlow?.();

  simAutoCoords = ruta.geometry.coordinates;
  simAutoAcumuladas = devConstruirTablaDistancias(simAutoCoords);
  simAutoDistanciaTotal = simAutoAcumuladas[simAutoAcumuladas.length - 1];
  simAutoTelefono = telefono;
  simAutoCallbackFinal = callbackAlLlegar;

  const inicio = performance.now();
  let ultimaEscritura = 0;

  function frame(ahora) {
    if (!simAutoCoords) return; // se cancelo/salteo desde otro lado

    const segundos = (ahora - inicio) / 1000;
    const distanciaRecorrida = VELOCIDAD_SIMULACION_MS * segundos;

    if (distanciaRecorrida >= simAutoDistanciaTotal) {
      simAutoSaltarAlFinal();
      return;
    }

    const punto = devPuntoEnDistancia(simAutoCoords, simAutoAcumuladas, distanciaRecorrida);
    pintarAutoEnMapa(punto.lat, punto.lng, punto.heading);
    dibujarRutaRestante(simAutoCoords, punto.indiceSegmento, punto.lat, punto.lng);
    posicionAutoMostrada = punto;

    if (ahora - ultimaEscritura > INTERVALO_ESCRITURA_SUPABASE_MS) {
      ultimaEscritura = ahora;
      simAutoEscribirSupabase(punto);
    }

    simAutoFrameId = requestAnimationFrame(frame);
  }

  simAutoFrameId = requestAnimationFrame(frame);
}

// ==================================================================
//  Controles de admin embebidos en el flujo REAL (no en el panel de
//  dev): un link para saltear la pantalla de "buscando conductor", y
//  botones en driver-sheet para saltear la animacion en curso o
//  arrancar el siguiente tramo del viaje. Solo visibles si esAdmin().
// ==================================================================
const devSaltarBuscando = document.getElementById('dev-saltar-buscando');
const devControlesViaje = document.getElementById('dev-controles-viaje');
const devBtnSaltarLeg = document.getElementById('dev-btn-saltar-leg');
const devBtnIniciarViajeSim = document.getElementById('dev-btn-iniciar-viaje-sim');

function actualizarControlesDevEnViaje() {
  const admin = esAdmin();

  devSaltarBuscando.style.display = admin && buscandoOverlay.classList.contains('show') ? 'block' : 'none';

  if (!admin || !viajeActivoPasajero) {
    devControlesViaje.style.display = 'none';
    return;
  }

  const estado = viajeActivoPasajero.estado;
  const enEspera = ['conductor_asignado', 'en_camino', 'llegó'].includes(estado);
  const enViaje = estado === 'en_viaje';

  devControlesViaje.style.display = (enEspera || enViaje) ? 'flex' : 'none';
  devBtnIniciarViajeSim.style.display = enEspera ? 'inline-block' : 'none';
  devBtnSaltarLeg.textContent = enViaje ? '⏭️ Saltear: llegar al destino' : '⏭️ Saltear animación';
}

devSaltarBuscando?.addEventListener('click', async () => {
  if (!viajeActivoPasajero) return;
  devSaltarBuscando.disabled = true;

  const { error } = await supabase
    .from('viajes')
    .update({
      estado: 'conductor_asignado',
      conductor_telefono: TELEFONO_CONDUCTOR_PRUEBA,
      nombre_conductor: 'Leyvan Esquercia',
      patente_conductor: 'AB123CD',
      modelo_auto_conductor: 'Toyota Corolla',
      color_auto_conductor: 'Gris',
      eta_minutos: 3,
    })
    .eq('id', viajeActivoPasajero.id);

  devSaltarBuscando.disabled = false;
  if (error) console.error('[Sim] Error al saltear la búsqueda de conductor:', error);
  // El resto (mostrar driver-sheet, arrancar la simulacion hacia el
  // origen) lo dispara solo la suscripcion Realtime del viaje.
});

devBtnSaltarLeg?.addEventListener('click', () => {
  simAutoSaltarAlFinal();
});

devBtnIniciarViajeSim?.addEventListener('click', async () => {
  if (!viajeActivoPasajero) return;
  devBtnIniciarViajeSim.disabled = true;

  // Si todavia estaba corriendo la simulacion de acercamiento al origen,
  // la cortamos limpio antes de arrancar el tramo del viaje.
  simAutoSaltarAlFinal();

  const { error } = await supabase
    .from('viajes')
    .update({ estado: 'en_viaje' })
    .eq('id', viajeActivoPasajero.id);

  devBtnIniciarViajeSim.disabled = false;
  if (error) {
    console.error('[Sim] Error al iniciar el viaje simulado:', error);
    return;
  }

  const origen = { lat: viajeActivoPasajero.origen_lat, lng: viajeActivoPasajero.origen_lng };
  const puntos = [origen, ...paradas.map((p) => ({ lat: p.lat, lng: p.lng }))];
  const telefono = viajeActivoPasajero.conductor_telefono;

  simAutoIniciar(puntos, telefono, () => {
    supabase.from('viajes').update({ estado: 'finalizado' }).eq('id', viajeActivoPasajero.id).then(({ error: errorFin }) => {
      if (errorFin) console.error('[Sim] Error marcando el viaje como finalizado:', errorFin);
    });
  });
});

let devSimulacionFrameId = null;

function devDetenerSimulacion(mensaje) {
  if (devSimulacionFrameId !== null) {
    cancelAnimationFrame(devSimulacionFrameId);
    devSimulacionFrameId = null;
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
  puntosRutaSeguidaActual = puntos;
  window._iniciarAnimacionGlow?.();

  const coords = ruta.geometry.coordinates; // [[lng,lat], ...]
  const acumuladas = devConstruirTablaDistancias(coords);
  const distanciaTotal = acumuladas[acumuladas.length - 1];

  const telefono = viajeActivoPasajero?.conductor_telefono
    || devViajeActivo?.conductor_telefono
    || TELEFONO_CONDUCTOR_PRUEBA;

  const segundosEstimados = Math.round(distanciaTotal / VELOCIDAD_SIMULACION_MS);
  devMostrarFeedback(devFeedbackSimulacion, `Simulando... 🚗 (${(distanciaTotal / 1000).toFixed(2)} km, ~${segundosEstimados}s)`);

  const inicio = performance.now();
  let ultimaEscritura = 0;

  function escribirEnSupabase(punto) {
    supabase
      .from('conductores')
      .update({ lat: punto.lat, lng: punto.lng, heading: punto.heading, actualizado_en: new Date().toISOString() })
      .eq('telefono', telefono)
      .then(({ error }) => {
        if (error) console.error('[Dev] Error escribiendo posición simulada:', error);
      });
  }

  function frame(ahora) {
    const segundosTranscurridos = (ahora - inicio) / 1000;
    const distanciaRecorrida = VELOCIDAD_SIMULACION_MS * segundosTranscurridos;

    if (distanciaRecorrida >= distanciaTotal) {
      const final = devPuntoEnDistancia(coords, acumuladas, distanciaTotal);
      pintarAutoEnMapa(final.lat, final.lng, final.heading);
      dibujarRutaRestante(coords, coords.length, final.lat, final.lng);
      posicionAutoMostrada = final;
      escribirEnSupabase(final);
      devDetenerSimulacion(textoOk);
      return;
    }

    const punto = devPuntoEnDistancia(coords, acumuladas, distanciaRecorrida);
    // Pintado directo, sin pasar por animarAutoHacia: como ya calculamos
    // una posicion nueva y precisa en cada frame (~60 veces por segundo),
    // no hace falta ninguna suavizacion extra encima — esa suavizacion es
    // para el caso de GPS real, que llega mucho mas espaciado.
    pintarAutoEnMapa(punto.lat, punto.lng, punto.heading);
    dibujarRutaRestante(coords, punto.indiceSegmento, punto.lat, punto.lng);
    posicionAutoMostrada = punto;

    if (ahora - ultimaEscritura > INTERVALO_ESCRITURA_SUPABASE_MS) {
      ultimaEscritura = ahora;
      escribirEnSupabase(punto);
    }

    devSimulacionFrameId = requestAnimationFrame(frame);
  }

  devSimulacionFrameId = requestAnimationFrame(frame);
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