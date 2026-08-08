# Convenciones

- Comentarios y textos de UI en español (Argentina).
- Sin tildes en el código/comentarios si el editor no maneja bien UTF-8 (ya causó corrupción de caracteres antes).
- No modificar constantes de balanceo sin pedirlo explícitamente (regla general de Dream Team, aplica igual acá si hay algo equivalente).
- Ante un bug: investigar primero con logging, sin tocar lógica de producción.
- Antes de terminar cualquier cambio: `npx eslint .` y `npx vite build` limpios, cero errores.

Ver también: [[00-Contexto]]
