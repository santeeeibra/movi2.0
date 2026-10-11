import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
  return source.slice(a, b);
}
function element() { return { style: {}, disabled: false, classList: { remove() {}, add() {} } }; }
function pickupFixture() {
  const calls = [];
  const context = {
    conductorViajeActivo: null,
    mostrarOverlay() {}, driverWaitingOverlay: element(), sheet: element(), paymentSheet: element(),
    driverActiveSheet: element(), driverActiveInfo: {}, actualizarBotonesViajeActivo() {},
    escaparHTML: (value) => String(value), telefonoParaContacto: () => '5492920123456',
    document: { getElementById: () => element() },
    supabase: { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{ direccion: 'Destino' }] }) }) }) }) },
    dibujarRutaConductorHaciaOrigen: async () => calls.push('pickup'),
    dibujarRutaConductorViajeCompleto: async () => calls.push('trip'),
  };
  vm.createContext(context);
  vm.runInContext(section('async function entrarAVistaViajeActiva(', 'function actualizarBotonesViajeActivo('), context);
  return { context, calls };
}
for (const [estado, expected] of [['conductor_asignado', 'pickup'], ['llegó', 'pickup'], ['en_viaje', 'trip']]) {
  test(`restored ${estado} uses the correct route`, async () => {
    const { context, calls } = pickupFixture();
    await context.entrarAVistaViajeActiva({ id: 'trip-test', estado, origen_lat: -40.8, origen_lng: -63 });
    assert.deepEqual(calls, [expected]);
  });
}

for (const outcome of [{ error: new Error('Offline'), data: null }, { error: null, data: null }, { error: null, data: { disponible: true } }]) {
  test(`availability follows the saved response (${outcome.data ? 'saved' : outcome.error ? 'offline' : 'no row'})`, async () => {
    let handler;
    const messages = [];
    const context = {
      conductorTelefonoActual: 'test', conductorDisponible: false,
      toggleDisponible: { disabled: false, addEventListener: (_, fn) => { handler = fn; } },
      actualizarToggleUI() {}, console: { error() {} }, mostrarToast: (message) => messages.push(message),
      supabase: { from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => outcome }) }) }) }) },
      iniciarListaPendientes() { context.listStarted = true; }, detenerListaPendientes() {}, driverPendingList: {},
    };
    vm.createContext(context);
    vm.runInContext(section("toggleDisponible.addEventListener('click'", '// ---- FASE 3:'), context);
    await handler();
    assert.equal(context.conductorDisponible, Boolean(outcome.data));
    assert.equal(Boolean(context.listStarted), Boolean(outcome.data));
    assert.equal(context.toggleDisponible.disabled, false);
    assert.equal(messages.length, outcome.data ? 0 : 1);
  });
}

function tripFixture(initialState = 'conductor_asignado', fail = false) {
  let row = { id: 'trip-test', estado: initialState, conductor_telefono: 'driver-test' };
  const passengerStates = [];
  const messages = [];
  const context = {
    conductorViajeActivo: row, conductorTelefonoActual: 'driver-test',
    console: { error() {} }, mostrarToast: (message) => messages.push(message),
    supabase: { from: () => {
      let changes;
      const filters = [];
      const query = {
        update: (value) => { changes = value; return query; },
        eq: (key, value) => { filters.push([key, value]); return query; },
        select: () => query,
        single: async () => {
          if (fail || filters.some(([key, value]) => row[key] !== value)) return { data: null, error: new Error('Not saved') };
          row = { ...row, ...changes };
          passengerStates.push(row.estado);
          return { data: row, error: null };
        },
      };
      return query;
    } },
    evaluarViajeConductor: (saved) => { context.conductorViajeActivo = saved; },
  };
  vm.createContext(context);
  vm.runInContext(section('async function cambiarEstadoViajeConductor(', "btnConductorLlegue.addEventListener('click'"), context);
  return { context, passengerStates, messages, getRow: () => row };
}

test('driver progresses from pickup through arrival, trip and completion without a Realtime echo', async () => {
  const { context, passengerStates } = tripFixture();
  for (const [from, to] of [['conductor_asignado', 'llegó'], ['llegó', 'en_viaje'], ['en_viaje', 'finalizado']]) {
    const button = element();
    await context.cambiarEstadoViajeConductor(button, from, to);
    assert.equal(context.conductorViajeActivo.estado, to);
    assert.equal(button.disabled, false);
  }
  assert.deepEqual(passengerStates, ['llegó', 'en_viaje', 'finalizado']);
});

test('failed state update does not pretend the trip has started', async () => {
  const { context, messages } = tripFixture('llegó', true);
  const button = element();
  await context.cambiarEstadoViajeConductor(button, 'llegó', 'en_viaje');
  assert.equal(context.conductorViajeActivo.estado, 'llegó');
  assert.equal(button.disabled, false);
  assert.equal(messages.length, 1);
});

test('driver cancellation before pickup creates no passenger cancellation charge', async () => {
  const { context, getRow } = tripFixture();
  await context.cambiarEstadoViajeConductor(element(), 'conductor_asignado', 'cancelado');
  assert.equal(getRow().estado, 'cancelado');
  assert.equal(getRow().tarifa_cancelacion, 0);
});

test('out-of-order trip action does not update a trip', async () => {
  const { context, passengerStates } = tripFixture();
  await context.cambiarEstadoViajeConductor(element(), 'en_viaje', 'finalizado');
  assert.equal(passengerStates.length, 0);
});

function acceptanceFixture(state = 'pendiente') {
  let row = { id: 'trip-test', estado: state, conductor_telefono: null };
  const context = {
    conductorViajeActivo: null, conductorTelefonoActual: 'driver-test', aceptandoViajeConductor: false,
    console: { error() {} }, mostrarToast() {}, setTimeout: (fn) => fn(),
    detenerListaPendientes() {}, actualizarToggleUI() {}, refrescarListaPendientes() {},
    evaluarViajeConductor: (saved) => { context.conductorViajeActivo = saved; },
    supabase: { from: (table) => {
      let changes;
      const filters = [];
      const query = {
        select: () => query,
        eq: (key, value) => { filters.push([key, value]); return query; },
        is: (key, value) => { filters.push([key, value]); return query; },
        update: (value) => { changes = value; return query; },
        maybeSingle: async () => ({ data: { telefono: 'driver-test', nombre: 'Chofer' }, error: null }),
        single: async () => {
          if (filters.some(([key, value]) => row[key] !== value)) return { data: null, error: new Error('Not available') };
          row = { ...row, ...changes };
          return { data: row, error: null };
        },
        then: (resolve) => resolve({ data: table === 'conductores' ? { disponible: false } : row, error: null }),
      };
      return query;
    } },
  };
  vm.createContext(context);
  vm.runInContext(section('async function aceptarViaje(', '// ---- FASE 4:'), context);
  return { context, getRow: () => row };
}

test('a cancelled but unassigned trip cannot be accepted', async () => {
  const { context, getRow } = acceptanceFixture('cancelado');
  await context.aceptarViaje('trip-test', element());
  assert.equal(getRow().estado, 'cancelado');
  assert.equal(getRow().conductor_telefono, null);
  assert.equal(context.conductorViajeActivo, null);
  assert.equal(context.aceptandoViajeConductor, false);
});

test('acceptance applies the returned trip without depending on Realtime', async () => {
  const { context } = acceptanceFixture();
  await context.aceptarViaje('trip-test', element());
  assert.equal(context.conductorViajeActivo.estado, 'conductor_asignado');
  assert.equal(context.conductorViajeActivo.conductor_telefono, 'driver-test');
  assert.equal(context.aceptandoViajeConductor, false);
});

test('driver cannot start a second acceptance while the first is in progress', async () => {
  const { context } = acceptanceFixture();
  const first = context.aceptarViaje('trip-test', element());
  const secondButton = element();
  await context.aceptarViaje('another-trip', secondButton);
  assert.equal(secondButton.disabled, false);
  await first;
  assert.equal(context.conductorViajeActivo.id, 'trip-test');
});

test('all fixed DOM element references exist in the page', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const match of source.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) ids.add(match[1]);
  const missing = [...source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
    .map((match) => match[1]).filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});
