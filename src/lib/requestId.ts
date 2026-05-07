// x-request-id propagation per contract §10.4. Caller-supplied IDs are
// echoed back; otherwise we mint a UUID v4.

const HEADER = "x-request-id";

export function extractOrCreateRequestId(request: Request): string {
  const supplied = request.headers.get(HEADER);
  if (supplied && isPlausibleId(supplied)) return supplied;
  return crypto.randomUUID();
}

// Defensive: cap length and reject anything that wouldn't make sense in a
// header value, so a malicious caller can't poison logs with newlines etc.
function isPlausibleId(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  return /^[A-Za-z0-9._\-:/+=]+$/.test(value);
}
