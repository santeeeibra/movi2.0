# Activar el acceso del conductor por correo

Este parche esta preparado en una copia de trabajo. No se ha desplegado,
no se han enviado correos y no se ha modificado la base de produccion.

## 1. Conectar el proyecto correcto

Movi utiliza `lapnbdpdkkeaaavvkfqc`. La cuenta de Supabase disponible en
esta sesion no incluye ese proyecto. Conectar la cuenta propietaria sin
compartir contrasenas ni claves en el chat.

Ejecutar primero `driver-email-preflight.sql` (solo lectura). Revisar las
columnas, permisos y triggers existentes antes de aplicar la propuesta
`driver-email-schema.sql`. Asegurar tambien una restriccion UNIQUE para
`conductores.telefono`, que es la identidad de contacto usada por el codigo
anterior. Generar una migracion con la CLI cuando el esquema este verificado.

La propuesta restringe escrituras de perfiles a su `auth_user_id` y valida
en el servidor las acciones del chofer. Conserva las politicas de lectura
existentes: hay que comprobar que el pasajero sigue recibiendo el GPS de su
conductor. No es una auditoria completa de las politicas de pasajeros,
lugares, historial y pagos; ese acceso sigue requiriendo una revision aparte.

Para perfiles antiguos, el propietario debe vincular `auth_user_id` a la
identidad de correo verificada. El formulario no toma posesion de perfiles
antiguos ni los sobrescribe solo por conocer un telefono. Los datos de
contacto no prueban que el chofer sea propietario de un numero o vehiculo.

## 2. Envio de correos sin SMS

Activar Email en Supabase Auth y configurar SMTP propio. El SMTP de prueba
de Supabase limita destinatarios y volumen; no sirve para abrir el acceso
al publico. Una opcion para empezar es Brevo: su plan gratuito anuncia
300 correos por dia. La cuota, la aprobacion de la cuenta y la verificacion
del remitente se deben comprobar al configurarlo. No se activa ningun plan
de pago desde este parche.

Fuentes oficiales:
- https://supabase.com/docs/guides/auth/auth-smtp
- https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans
- https://supabase.com/docs/guides/auth/auth-email-passwordless

Configurar las plantillas **Magic Link** y **Confirm signup** para mostrar
`{{ .Token }}` en el cuerpo. El formulario espera un codigo de seis digitos.
Configurar la longitud del OTP en seis, expiracion y limites de reenvio.
Con SMTP por defecto, ciertos proyectos Free nuevos no permiten editar las
plantillas; SMTP propio es parte de esta activacion.

Plantilla simple, sin enlaces ni promociones:

```html
<h2>Tu codigo para ingresar a Movi</h2>
<p>Ingresa este codigo en la app: <strong>{{ .Token }}</strong></p>
<p>Si no lo pediste, ignora este correo.</p>
```

Las credenciales SMTP se guardan en Supabase, nunca en Vercel como variables
publicas ni dentro del repositorio.

## 3. Validacion y despliegue de prueba

Los controles de simulacion y el ingreso admin de prueba quedan disponibles
solo en desarrollo, no en el build de produccion. Para simular el GPS real
de un chofer se necesita el navegador de pruebas o dos dispositivos en la
zona. No hace falta una VPN.

Pruebas automaticas: `npm test`. Verificacion del codigo: `npm run lint`.
Compilacion: `npm run build`.

Antes de publicar, usar una version de prueba con dos sesiones independientes:
1. Conductor: ingresar correo, recibir y verificar codigo; conectar GPS.
2. Pasajero: elegir origen y destino; pedir viaje.
3. Conductor: aceptar, contactar pasajero, tocar Llegue e Iniciar viaje.
4. Recargar durante el viaje: la ruta debe continuar hacia el destino.
5. Finalizar: pasajero ve pago; conductor vuelve a disponibilidad real.
6. Repetir cancelacion antes de recoger, error de conexion y GPS denegado.
7. Comprobar dos choferes aceptando el mismo pedido: solo uno debe ganar.
8. Comprobar dos dispositivos del mismo chofer aceptando pedidos diferentes.
9. Verificar entrega del correo, codigo incorrecto, vencido y reenvio.
10. Comprobar que un usuario no pueda escribir en el perfil de otro chofer.

Las pruebas automaticas usan servicios simulados. No prueban entrega de
correo, politicas reales de la base, GPS con pantalla bloqueada ni cobros.
La lista aun muestra todos los pedidos de la ciudad; radio de cercania y
seguimiento con la pantalla bloqueada quedan para otra iteracion.
