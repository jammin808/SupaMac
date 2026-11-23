import type { Miniflare } from 'miniflare';
import { beforeEach, describe, expect, test } from 'vitest';
import { createTestUser, getTokenForDocument, setupMiniflare } from './utils';

let mf: Miniflare;

beforeEach(async () => {
  mf = await setupMiniflare();
});

describe('CORS middleware tests', async () => {
  test('should allow requests from whitelisted origins', async () => {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:3999',
      'http://localhost:20010',
      'http://localhost:60000',
      'http://host.local:3000',
      'capacitor://localhost',
    ];

    const token = getTokenForDocument('test-doc', 'test-user', 'owner');

    for (const origin of allowedOrigins) {
      const response = await mf.dispatchFetch(
        'http://localhost:8787/document/test-doc/metadata',
        {
          headers: {
            Authorization: 'Bearer ' + token,
            Origin: origin,
          },
        }
      );

      // Should get 404 (document doesn't exist) but CORS should be allowed
      expect([200, 404]).toContain(response.status);

      // Check CORS headers
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
        'true'
      );
    }
  });

  test('should handle preflight OPTIONS requests', async () => {
    const response = await mf.dispatchFetch(
      'http://localhost:8787/document/test-doc/metadata',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      }
    );

    expect(response.status).toBe(200);

    // Check preflight response headers
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:3000'
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true'
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'GET'
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST'
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'OPTIONS'
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
      'authorization'
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
      'content-type'
    );
  });

  test('should reject requests from non-whitelisted origins', async () => {
    const disallowedOrigins = [
      'https://malicious.com',
      'http://localhost:8080',
      // With no ALLOWED_ORIGINS, no public origin is allowed.
      'https://example.com',
      'https://www.example.com',
      'https://feature.preview.example.com',
    ];

    const token = getTokenForDocument('test-doc', 'test-user', 'owner');

    for (const origin of disallowedOrigins) {
      const response = await mf.dispatchFetch(
        'http://localhost:8787/document/test-doc/metadata',
        {
          headers: {
            Authorization: 'Bearer ' + token,
            Origin: origin,
          },
        }
      );

      // CORS should block the request or not set Access-Control-Allow-Origin
      const allowedOrigin = response.headers.get('Access-Control-Allow-Origin');
      expect(allowedOrigin).not.toBe(origin);
    }
  });

  test('should allow all HTTP methods for whitelisted origins', async () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const origin = 'http://localhost:3000';

    for (const method of methods) {
      const response = await mf.dispatchFetch(
        'http://localhost:8787/document/test-doc/metadata',
        {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': method,
          },
        }
      );

      expect(response.status).toBe(200);
      const allowedMethods = response.headers.get(
        'Access-Control-Allow-Methods'
      );
      expect(allowedMethods).toContain(method);
    }
  });

  test('should allow required headers for API requests', async () => {
    const response = await mf.dispatchFetch(
      'http://localhost:8787/document/test-doc/metadata',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      }
    );

    expect(response.status).toBe(200);
    const allowedHeaders = response.headers.get('Access-Control-Allow-Headers');
    expect(allowedHeaders).toContain('authorization');
    expect(allowedHeaders).toContain('content-type');
  });

  // The web client's traced fetch wrapper injects W3C trace context on every
  // instrumented request. If these aren't preflight-allowed the browser blocks
  // the response outright, which previously broke /metadata (and with it the
  // document history timeline and blame tooltips).
  test('should allow w3c trace context headers', async () => {
    const response = await mf.dispatchFetch(
      'http://localhost:8787/document/test-doc/metadata',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,traceparent',
        },
      }
    );

    expect(response.status).toBe(200);
    const allowedHeaders = response.headers.get('Access-Control-Allow-Headers');
    expect(allowedHeaders).toContain('traceparent');
    expect(allowedHeaders).toContain('tracestate');
  });

  test('should work with actual API requests after CORS validation', async () => {
    // Create a document first
    const user = await createTestUser(mf, 'cors-test-doc');
    user.makeChange('CORS test content');

    await new Promise((resolve) => setTimeout(resolve, 100));

    const token = getTokenForDocument('cors-test-doc', 'test-user', 'owner');

    // Make actual API request with CORS headers
    const response = await mf.dispatchFetch(
      'http://localhost:8787/document/cors-test-doc/metadata',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
        },
      }
    );

    expect(response.status).toBe(200);

    // Verify both API response and CORS headers
    const metadata = await response.json();
    expect(metadata.id).toBe('cors-test-doc');

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:3000'
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true'
    );

    user.connection.getWebSocket().close();
  });

  test('should handle mobile app origins (Capacitor)', async () => {
    const token = getTokenForDocument('test-doc', 'test-user', 'owner');

    const response = await mf.dispatchFetch(
      'http://localhost:8787/document/test-doc/metadata',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          Origin: 'capacitor://localhost',
        },
      }
    );

    // Should allow Capacitor origin
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'capacitor://localhost'
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true'
    );
  });

  test('should allow exactly the origins ALLOWED_ORIGINS names', async () => {
    const configured = await setupMiniflare({
      allowedOrigins: 'https://app.example.com',
    });
    const token = getTokenForDocument('test-doc', 'test-user', 'owner');
    const fetchFrom = (origin: string) =>
      configured.dispatchFetch(
        'http://localhost:8787/document/test-doc/metadata',
        {
          headers: {
            Authorization: 'Bearer ' + token,
            Origin: origin,
          },
        }
      );

    const allowed = await fetchFrom('https://app.example.com');
    expect([200, 404]).toContain(allowed.status);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com'
    );

    for (const origin of [
      'http://localhost:3000',
      'capacitor://localhost',
      'https://example.com',
      'https://app.example.com:8443',
    ]) {
      const response = await fetchFrom(origin);
      expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe(
        origin
      );
    }

    await configured.dispose();
  });

  test('should handle requests without Origin header', async () => {
    const token = getTokenForDocument('test-doc', 'test-user', 'owner');

    const response = await mf.dispatchFetch(
      'http://localhost:8787/document/test-doc/metadata',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          // No Origin header
        },
      }
    );

    // Should work for same-origin requests (no Origin header)
    expect([200, 404]).toContain(response.status);
  });
});
