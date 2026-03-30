export type ServerLogLevel = "info" | "warn" | "error";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function serializeLogValue(value: unknown): string {
  if (value == null) {
    return String(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    return /^[a-zA-Z0-9._:/@-]+$/.test(normalized) ? normalized : JSON.stringify(normalized);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }

  if (durationMs < 10_000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function logServerEvent(
  scope: string,
  message: string,
  fields: Record<string, unknown> = {},
  level: ServerLogLevel = "info",
): void {
  const timestamp = new Date().toISOString();
  const serializedFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${serializeLogValue(value)}`)
    .join(" ");
  const line = `${timestamp} [${level}] [${scope}] ${message}${serializedFields ? ` ${serializedFields}` : ""}`;

  if (level === "error") {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}
