const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const MAX_S3_KEY_BYTES = 1024;

export function assertSafeObjectKey(key: string): string {
  if (key.length === 0) {
    throw new Error("Object key cannot be empty");
  }

  if (CONTROL_CHARACTER.test(key)) {
    throw new Error("Object key cannot contain control characters");
  }

  if (Buffer.byteLength(key, "utf8") > MAX_S3_KEY_BYTES) {
    throw new Error("Object key cannot exceed 1024 UTF-8 bytes");
  }

  return key;
}

export function toPrefixMarkerKey(prefix: string): string {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;

  return assertSafeObjectKey(normalized);
}
