import { SELF_HOSTED } from '@core/constant/servers';
import { z } from 'zod';

// A self-hosted bundle is published under a Content-Security-Policy with no
// 'unsafe-eval'. zod probes for `new Function` before compiling an object
// parser; the browser refuses the probe there and reports a violation on
// every load. Declaring compiled parsers unavailable skips the probe. This
// module must be evaluated before any schema parses, so the entry imports it
// first.
if (SELF_HOSTED) z.config({ jitless: true });
