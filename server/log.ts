export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;
export type Logger = (event: string, fields?: LogFields) => void;

/**
 * Structured one-line JSON events on stdout. Callers must never pass secrets:
 * tokens, passwords, API keys, cookies or stream ticket paths.
 */
export const logEvent: Logger = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
};

export const silentLogger: Logger = () => {};
