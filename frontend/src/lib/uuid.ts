// crypto.randomUUID() only exists in secure contexts (HTTPS, or the
// literal hostname "localhost") — a page opened over plain http:// on a
// LAN IP (e.g. testing from a phone against a dev server) doesn't
// qualify, so the call throws and silently kills whatever click handler
// called it. crypto.getRandomValues() has no such restriction, so build
// a UUID v4 from it whenever randomUUID isn't there.
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
