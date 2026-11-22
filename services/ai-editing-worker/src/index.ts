import './globals';
import {
  createWorkerTraceConfig,
  instrument,
} from '@macro-inc/observability/worker';
import { Hono } from 'hono';
import { appLinks } from './app-links';
import { originCors } from './cors';
import endpoints from './endpoints';
import docx from './endpoints/docx';
import type { Bindings } from './env';

const app = new Hono<{ Bindings: Bindings }>();

// The web app calls /edit directly from the browser; auth is the document
// permission token in the body, and CORS admits the origins ALLOWED_ORIGINS
// names (src/cors.ts).
app.use('*', originCors());
// Links in converted documents follow APP_URL and STATIC_FILE_URL.
app.use('*', appLinks());
app.route('/', endpoints);
app.route('/docx', docx);

// instrument() wraps fetch with a request root span, registers the global
// tracer provider/context manager (which Telemetry.span resolves through),
// propagates traceparent, and flushes spans via waitUntil after the response.
export default instrument({ fetch: app.fetch }, (env: Bindings) =>
  createWorkerTraceConfig({
    serviceName: 'ai-editing-worker',
    environment: env.ENVIRONMENT ?? 'local',
    tracesUrl: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    tracesHeaders: env.DD_API_KEY
      ? { 'dd-api-key': env.DD_API_KEY }
      : undefined,
  })
);
