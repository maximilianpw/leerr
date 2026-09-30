export type UpstreamCode =
  | "upstream_auth"
  | "upstream_unavailable"
  | "upstream_protocol"
  | "upstream_rejected"
  | "invalid_endpoint";

/**
 * Whether a failed mutation could have taken effect upstream. `not_applied`
 * is only used when the request provably never reached the service or the
 * service explicitly rejected it; everything else is `unknown`.
 */
export type MutationOutcome = "not_applied" | "unknown";

const defaultMessages: Record<UpstreamCode, string> = {
  upstream_auth: "The upstream service rejected its credentials.",
  upstream_unavailable: "The upstream service is unavailable.",
  upstream_protocol: "The upstream service returned an invalid response.",
  upstream_rejected: "The upstream service rejected the request.",
  invalid_endpoint:
    "Enter an HTTPS server URL without embedded credentials, query parameters, or a fragment.",
};

export class UpstreamError extends Error {
  readonly code: UpstreamCode;
  readonly status: number;
  readonly outcome: MutationOutcome;
  constructor(
    code: UpstreamCode,
    status: number,
    message?: string,
    outcome: MutationOutcome = "unknown",
  ) {
    super(message ?? defaultMessages[code]);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
    this.outcome = outcome;
  }
}

/** Normalises an administrator-supplied service URL, retaining any subpath. */
export function validateEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UpstreamError("invalid_endpoint", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new UpstreamError("invalid_endpoint", 400);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function endpointURL(endpoint: string, path: string): URL {
  return new URL(`${validateEndpoint(endpoint)}/${path}`);
}
