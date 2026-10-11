// El correo verifica la identidad del conductor; el telefono es de contacto.
// La propiedad del perfil se valida tambien con RLS en Supabase.
export function createDriverAuth(client) {
  async function requestCode(email) {
    const correo = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      throw new Error('Ingresá un correo electrónico válido.');
    }
    const { error } = await client.auth.signInWithOtp({
      email: correo,
      options: { shouldCreateUser: true },
    });
    if (error) throw new Error(error.status === 429
      ? 'Esperá un minuto antes de pedir otro código.'
      : 'No pudimos enviar el código. Revisá tu conexión o contactá a Movi.');
    return correo;
  }

  async function verifiedUser() {
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user?.id || !data.user.email_confirmed_at) {
      throw new Error('Ingresá con el código de tu correo para continuar.');
    }
    return data.user;
  }

  async function loadProfile() {
    const user = await verifiedUser();
    const { data, error } = await client.from('conductores')
      .select('*').eq('auth_user_id', user.id).maybeSingle();
    if (error) throw new Error('No pudimos recuperar tu perfil. Contactá a Movi.');
    return data;
  }

  async function verifyAndSave(email, code, profile) {
    if (!/^\d{6}$/.test(code)) throw new Error('Ingresá el código de 6 dígitos.');
    const { error } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) throw new Error('Código incorrecto o vencido. Intentá de nuevo.');
    // getUser consulta al servidor: el telefono guardado en el dispositivo
    // nunca sirve como prueba de identidad.
    const user = await verifiedUser();
    if (user.email?.toLowerCase() !== email.toLowerCase()) {
      throw new Error('El correo verificado no coincide. Volvé a ingresar.');
    }
    const { data: existing, error: readError } = await client.from('conductores')
      .select('*').eq('auth_user_id', user.id).maybeSingle();
    if (readError) throw new Error('El acceso por correo todavía no está habilitado. Contactá a Movi.');
    if (existing && existing.telefono !== profile.telefono) {
      throw new Error('Usá el teléfono de tu perfil. Para cambiarlo, contactá a Movi.');
    }
    const row = { ...profile, auth_user_id: user.id };
    const query = existing
      ? client.from('conductores').update(row).eq('auth_user_id', user.id)
      : client.from('conductores').insert(row);
    const { data, error: saveError } = await query.select('*').single();
    if (saveError || !data) throw new Error(saveError?.code === '23505'
      ? 'Ese teléfono ya está registrado. Contactá a Movi para recuperar el acceso.'
      : 'No pudimos guardar tu perfil. Contactá a Movi o intentá nuevamente.');
    return data;
  }

  return { requestCode, loadProfile, verifyAndSave };
}
