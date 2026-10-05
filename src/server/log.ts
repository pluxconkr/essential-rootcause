/**
 * Structured JSON logger for the API routes (plan §12 "structured logs without PII"). One line per event:
 * {ts, level, event, requestId?, route?, durationMs?, ...fields}. Field names that look like secrets or personal data
 * (token, secret, authorization, phone, email, address, geom, home, install id, storage keys) are masked before the
 * line is written, so a careless call site cannot leak them; Error values are reduced to {name, message}.
 * Server-only module. Tests swap the sink with setLogSink().
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string, level: LogLevel) => void;

/** Field names whose values are never written (plan §12: phone numbers masked, no PII, no secrets). */
const MASKED_FIELD = /token|secret|password|authorization|cookie|bearer|phone|email|address|geom|home|install|_key$|apikey/i;

let sink: LogSink | null = null;

/** Tests capture lines here; null restores the console. */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (MASKED_FIELD.test(key)) out[key] = '[redacted]';
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else out[key] = value;
  }
  return out;
}

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, unserializable: true });
  }
  if (sink) {
    sink(line, level);
    return;
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
