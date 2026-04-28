# Wake Blob Fixture

`wake-blob-fixture.json` is deterministic on purpose. It uses:

- `sessionRecvKey`: bytes `0x00...0x1f`
- nonce: bytes `0x20...0x2b`
- HKDF salt: `agent-pocket-v1`
- HKDF info: `agent-pocket-wake-blob-key`
- cipher: ChaCha20-Poly1305
- plaintext: 2-byte big-endian UTF-8 length + JSON payload + zero padding to 1024 bytes

Regenerate it from the repo root with:

```bash
node - <<'NODE'
const crypto = require('node:crypto');
const sendKey = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const nonce = Buffer.from('202122232425262728292a2b', 'hex');
const payload = JSON.stringify({
  type: 'permission_request',
  session_name: 'Fixture Session',
  body: 'Bash command needs approval',
  category: 'PERMISSION_REQUEST',
  session_id: 'session-fixture',
  request_id: 'request-fixture',
});
const key = crypto.hkdfSync(
  'sha256',
  sendKey,
  Buffer.from('agent-pocket-v1'),
  Buffer.from('agent-pocket-wake-blob-key'),
  32,
);
const plaintext = Buffer.alloc(1024);
const data = Buffer.from(payload, 'utf8');
plaintext.writeUInt16BE(data.length, 0);
data.copy(plaintext, 2);
const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
console.log(JSON.stringify({
  sessionRecvKey: sendKey.toString('base64'),
  payload,
  blob: Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64'),
}, null, 2));
NODE
```
