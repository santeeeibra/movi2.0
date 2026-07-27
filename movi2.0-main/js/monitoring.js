// Monitoreo de errores con Sentry — opcional. Si no hay DSN configurado
// (SENTRY_DSN vacio) no hace nada, no rompe la app.
const SENTRY_DSN = '';

export function initMonitoring() {
  if (!SENTRY_DSN) return;

  const esLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (esLocalhost) return;

  const scriptTag = document.createElement('script');
  scriptTag.src = 'https://browser.sentry-cdn.com/7.120.0/bundle.tracing.min.js';
  scriptTag.crossOrigin = 'anonymous';
  scriptTag.onload = () => {
    if (!window.Sentry) return;
    window.Sentry.init({
      dsn: SENTRY_DSN,
      sampleRate: 0.2,
      tracesSampleRate: 0.1,
    });
  };
  document.head.appendChild(scriptTag);
}
