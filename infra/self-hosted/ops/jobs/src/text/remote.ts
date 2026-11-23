// The service's side of the extraction container (docs/supamac/jobs.md,
// Security: Hostile files): a source's bytes go over HTTP to
// extract-server.ts, which parses them in a child of its own, in a
// container that holds no secret, no state volume and no route out.
//
// Invariants:
// - The answer is validated here again (wire.ts), whatever the server
//   validated: the extraction container is where hostile files are parsed,
//   so nothing it says is trusted.
// - A file over the read limit is refused here, before it is sent.
// - The container not answering, answering with a status other than 200, or
//   taking longer than the sandbox's own limit plus a margin is a retryable
//   PipelineError: the source waits and is read again, never failed for it.
//   An answer that does not validate is the file's failure (`bad_output`),
//   as it is for a child in this process.

import { PipelineError } from '../pipeline/context';
import { SANDBOX_DEFAULTS } from './sandbox';
import {
  type ExtractHint,
  type ExtractOutcome,
  LIMITS,
  sizeText,
} from './types';
import {
  decodeOutcome,
  encodeRequest,
  REQUEST_HEADER,
  type WorkerRequest,
} from './wire';

export type RemoteFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export interface RemoteExtractorOptions {
  readonly fetch?: RemoteFetch | undefined;
  /** How long one extraction may take, the server's own limit included. */
  readonly timeoutMs?: number | undefined;
}

/** An extractor that sends each source to the extraction container at `baseUrl`. */
export function remoteExtractor(
  baseUrl: string,
  options: RemoteExtractorOptions = {}
): (bytes: Uint8Array, hint: ExtractHint) => Promise<ExtractOutcome> {
  const url = `${baseUrl.replace(/\/+$/, '')}/extract`;
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? SANDBOX_DEFAULTS.timeoutMs + 30_000;
  return async (bytes, hint) => {
    if (bytes.length > LIMITS.maxBytes) {
      return {
        ok: false,
        refusal: {
          kind: 'too_large',
          reason: `The file is ${sizeText(bytes.length)}, over the ${sizeText(LIMITS.maxBytes)} read.`,
        },
      };
    }
    const request: WorkerRequest = {
      hint: { name: hint.name, contentType: hint.contentType },
      limits: {},
    };
    let response: Response;
    let body: string;
    try {
      response = await send(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          [REQUEST_HEADER]: encodeRequest(request),
        },
        body: bytes,
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await response.text();
    } catch (error) {
      throw new PipelineError(
        'retryable',
        `the extraction container did not answer (${error instanceof Error ? error.name : 'error'})`,
        { cause: error }
      );
    }
    if (response.status !== 200) {
      throw new PipelineError(
        'retryable',
        `the extraction container answered ${response.status}`
      );
    }
    return (
      decodeOutcome(body) ?? {
        ok: false,
        refusal: {
          kind: 'bad_output',
          reason: 'The reader answered with something that is not a result.',
        },
      }
    );
  };
}
