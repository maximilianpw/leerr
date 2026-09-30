/** An error whose code and message are safe and useful to show to the client. */
export class APIError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = () => new APIError(401, "unauthorized", "Your session has ended. Sign in again.");
export const notFound = (what: string) => new APIError(404, "not_found", `${what} not found.`);
