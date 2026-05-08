// Truncate `value` so its UTF-8 byte length is at most `maxBytes`. Slices on
// codepoint boundaries to avoid emitting partial multi-byte sequences (used
// for APNs/wake-payload bodies which have a hard 256-byte cap on iOS).
export function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}
