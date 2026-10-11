import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriverAuth } from '../js/driverauth.js';

const email = 'chofer@example.com';
const profile = { telefono: '5492920123456', nombre: 'Chofer de prueba', patente: 'AB123CD', modelo_auto: 'Auto de prueba', color_auto: 'Gris' };
const user = { id: 'verified-driver', email, email_confirmed_at: '2026-10-11T00:00:00Z' };

function clientFixture({ otpError = null, userError = null, existing = null, saveError = null } = {}) {
  const calls = [];
  const client = {
    auth: {
      signInWithOtp: async (args) => { calls.push(['send', args]); return { error: otpError }; },
      verifyOtp: async (args) => { calls.push(['verify', args]); return { error: otpError }; },
      getUser: async () => { calls.push(['user']); return { data: { user: userError ? null : user }, error: userError }; },
    },
    from: (table) => {
      calls.push(['table', table]);
      let savedRow;
      const query = {
        select: () => query,
        eq: (column, value) => { calls.push(['filter', column, value]); return query; },
        maybeSingle: async () => ({ data: existing, error: null }),
        insert: (row) => { calls.push(['insert', row]); savedRow = row; return query; },
        update: (row) => { calls.push(['update', row]); savedRow = row; return query; },
        single: async () => ({ data: saveError ? null : savedRow, error: saveError }),
      };
      return query;
    },
  };
  return { auth: createDriverAuth(client), calls };
}

test('requesting a code normalizes email and never saves an unverified driver', async () => {
  const { auth, calls } = clientFixture();
  assert.equal(await auth.requestCode(' Chofer@Example.com '), email);
  assert.deepEqual(calls, [['send', { email, options: { shouldCreateUser: true } }]]);
});

test('invalid email is rejected before any request', async () => {
  const { auth, calls } = clientFixture();
  await assert.rejects(auth.requestCode('not-an-email'), /válido/);
  assert.equal(calls.length, 0);
});

test('rate limiting is explained without claiming a code was sent', async () => {
  const { auth } = clientFixture({ otpError: { status: 429 } });
  await assert.rejects(auth.requestCode(email), /Esperá un minuto/);
});

test('wrong code never reads or writes a driver profile', async () => {
  const { auth, calls } = clientFixture({ otpError: { status: 403 } });
  await assert.rejects(auth.verifyAndSave(email, '000000', profile), /incorrecto o vencido/);
  assert.equal(calls.some(([type]) => type === 'table'), false);
});

test('malformed code does not contact the backend', async () => {
  const { auth, calls } = clientFixture();
  await assert.rejects(auth.verifyAndSave(email, 'abcdef', profile), /6 dígitos/);
  assert.equal(calls.length, 0);
});

test('verified signup creates a profile bound to the server-verified user', async () => {
  const { auth, calls } = clientFixture();
  assert.equal((await auth.verifyAndSave(email, '123456', profile)).auth_user_id, user.id);
  assert.deepEqual(calls.find(([type]) => type === 'insert')[1], { ...profile, auth_user_id: user.id });
  assert.ok(calls.findIndex(([type]) => type === 'verify') < calls.findIndex(([type]) => type === 'insert'));
});

test('existing driver updates only their own authenticated profile', async () => {
  const { auth, calls } = clientFixture({ existing: { ...profile, auth_user_id: user.id } });
  await auth.verifyAndSave(email, '123456', profile);
  assert.ok(calls.some(([type]) => type === 'update'));
  assert.ok(calls.filter(([type, column, id]) => type === 'filter' && column === 'auth_user_id' && id === user.id).length >= 2);
});

test('existing phone cannot silently be replaced', async () => {
  const { auth, calls } = clientFixture({ existing: { ...profile, telefono: '5492920654321' } });
  await assert.rejects(auth.verifyAndSave(email, '123456', profile), /teléfono de tu perfil/);
  assert.equal(calls.some(([type]) => type === 'update' || type === 'insert'), false);
});

test('legacy phone belongs to an existing profile and is not overwritten', async () => {
  const { auth } = clientFixture({ saveError: { code: '23505' } });
  await assert.rejects(auth.verifyAndSave(email, '123456', profile), /recuperar el acceso/);
});

test('expired authentication cannot restore a driver from local phone data', async () => {
  const { auth, calls } = clientFixture({ userError: { status: 401 } });
  await assert.rejects(auth.loadProfile(), /código de tu correo/);
  assert.equal(calls.some(([type]) => type === 'table'), false);
});
