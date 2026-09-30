import { z } from "zod";
import { UpstreamError } from "./errors.ts";

const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;
export type Fetcher = typeof fetch;

export type CallOptions = {
  /** Human-readable service name used in diagnostics. */
  service: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

export type JsonResponse = { status: number; body: JsonValue };

// Failures that prove the request never reached the service.
const notSentCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const causeCode = z.object({
  cause: z.object({ code: z.string() }).loose(),
});

function transportError(cause: unknown, service: string): UpstreamError {
  const parsed = causeCode.safeParse(cause);
  const notSent = parsed.success && notSentCodes.has(parsed.data.cause.code);
  return new UpstreamError(
    "upstream_unavailable",
    503,
    notSent
      ? `${service} could not be reached (${parsed.data.cause.code}).`
      : `${service} did not respond in time or closed the connection.`,
    notSent ? "not_applied" : "unknown",
  );
}

export function statusError(status: number, service: string): UpstreamError {
  if (status === 401)
    return new UpstreamError(
      "upstream_auth",
      502,
      `${service} returned HTTP 401 (unauthorized). Check the account or API key and any proxy authentication requirements.`,
      "not_applied",
    );
  if (status === 403)
    return new UpstreamError(
      "upstream_auth",
      502,
      `${service} returned HTTP 403 (forbidden). Check account permissions, remote-access policy, and proxy access rules; this does not necessarily mean the password is wrong.`,
      "not_applied",
    );
  if (status === 429)
    return new UpstreamError(
      "upstream_unavailable",
      503,
      `${service} is rate limiting requests. Try again shortly.`,
      "not_applied",
    );
  if (status >= 500)
    return new UpstreamError(
      "upstream_unavailable",
      503,
      `${service} returned HTTP ${status}.`,
    );
  return new UpstreamError(
    "upstream_rejected",
    502,
    `${service} rejected the request (HTTP ${status}).`,
    "not_applied",
  );
}

export async function readBounded(
  response: Response,
  maximum: number,
  service: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > maximum) {
    await response.body?.cancel();
    throw new UpstreamError(
      "upstream_protocol",
      502,
      `${service} returned an oversized response.`,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new UpstreamError(
          "upstream_protocol",
          502,
          `${service} returned an oversized response.`,
        );
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof UpstreamError) throw cause;
    throw transportError(cause, service);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Bounded upstream HTTP: never follows redirects (credentials must not leave
 * the configured origin), always times out, and caps response sizes.
 */
export class HttpClient {
  readonly #fetcher: Fetcher;
  constructor(fetcher: Fetcher) {
    this.#fetcher = fetcher;
  }

  /** Returns the response once headers arrive; the body is the caller's to consume. */
  async open(
    url: URL,
    init: RequestInit,
    options: CallOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) throw cause;
      throw transportError(cause, options.service);
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new UpstreamError(
        "upstream_protocol",
        502,
        `${options.service} redirected the request. Configure its final HTTPS address.`,
        "not_applied",
      );
    }
    return response;
  }

  /** JSON with a deadline covering the whole body, not just the headers. */
  async json(
    url: URL,
    init: RequestInit,
    options: CallOptions,
  ): Promise<JsonValue> {
    const result = await this.jsonResponse(url, init, options);
    if (result.status < 200 || result.status > 299)
      throw statusError(result.status, options.service);
    return result.body;
  }

  /** Like json(), but returns non-2xx JSON bodies for services with error envelopes. */
  async jsonResponse(
    url: URL,
    init: RequestInit,
    options: CallOptions,
  ): Promise<JsonResponse> {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const signal = options.signal
      ? AbortSignal.any([deadline, options.signal])
      : deadline;
    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await this.open(url, init, { ...options, signal });
      bytes = await readBounded(
        response,
        options.maxBytes ?? 2_000_000,
        options.service,
      );
    } catch (cause) {
      if (cause instanceof UpstreamError || !deadline.aborted) throw cause;
      throw transportError(cause, options.service);
    }
    try {
      return {
        status: response.status,
        body: jsonValue.parse(JSON.parse(new TextDecoder().decode(bytes))),
      };
    } catch {
      if (!response.ok) throw statusError(response.status, options.service);
      throw new UpstreamError(
        "upstream_protocol",
        502,
        `${options.service} did not return valid JSON. Check the server URL and reverse-proxy route.`,
      );
    }
  }
}

export function parseBody<T>(
  schema: z.ZodType<T>,
  body: JsonValue,
  service: string,
): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new UpstreamError(
      "upstream_protocol",
      502,
      `${service} returned a response Leerr does not understand.`,
    );
  return result.data;
}
