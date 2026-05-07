// Structured logs to Cloudflare Logs (§10.1, §10.2). One JSON line per event.

import type { LogFields, LogLevel } from "../types.ts";

export function log(level: LogLevel, fields: LogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    op: fields.op,
    code: fields.code,
    requestId: fields.requestId,
    userId: fields.userId ?? null,
    tokenJti: fields.tokenJti ?? null,
    key: fields.key ?? null,
    chatId: fields.chatId ?? null,
    bytes: fields.bytes ?? null,
    contentType: fields.contentType ?? null,
    ip: fields.ip ?? null,
    ua: fields.ua ?? null,
    extra: fields.extra ?? {},
  };
  // Cloudflare Logs ingests stdout JSON.
  console.log(JSON.stringify(entry));
}

// User-Agent can be arbitrarily long; cap to avoid blowing log size.
export function truncateUa(ua: string | null): string | null {
  if (ua === null) return null;
  return ua.length > 200 ? ua.slice(0, 200) : ua;
}
