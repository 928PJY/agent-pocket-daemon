import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { LanPairRequest, LanPairResponse } from 'agent-pocket-protocol';
import { runLanPairing } from '../src/lan/lan-pairing.js';
import { LanServer } from '../src/lan/lan-server.js';
import { rawEd25519ToSpki } from '../src/crypto/key-format.js';

const originalConsoleLog = console.log;
const originalGetLanAddresses = LanServer.getLanAddresses;
const originalEmitWarning = process.emitWarning;

afterEach(() => {
  console.log = originalConsoleLog;
  LanServer.getLanAddresses = originalGetLanAddresses;
  process.emitWarning = originalEmitWarning;
});

class FakeLanServer {
  handler: ((req: LanPairRequest) => LanPairResponse) | null = null;
  handlerUpdates: Array<boolean> = [];

  setPairCompleteHandler(handler: ((req: LanPairRequest) => LanPairResponse) | null): void {
    this.handler = handler;
    this.handlerUpdates.push(handler !== null);
  }
}

async function waitForHandler(lanServer: FakeLanServer): Promise<(req: LanPairRequest) => LanPairResponse> {
  for (let i = 0; i < 20; i++) {
    if (lanServer.handler) return lanServer.handler;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('pair complete handler was not registered');
}

function rawKey(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

function validIdentitySpki(): string {
  return rawEd25519ToSpki(rawKey(9));
}

function makeCryptoEngine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generateEphemeralKeyPair: () => {},
    getEphemeralPublicKeyBase64: () => rawKey(1),
    deriveSharedSecret: (peerPublicKey: string) => Buffer.from(peerPublicKey),
    deriveSessionKeys: () => ({
      sendKey: Buffer.from('send-key'),
      recvKey: Buffer.from('recv-key'),
      sasKey: Buffer.from('sas-key'),
    }),
    setPeerIdentityPublicKey: () => {},
    getIdentityPublicKeyBase64: () => validIdentitySpki(),
    getSessionKeys: () => ({
      sendKey: Buffer.from('send-key'),
      recvKey: Buffer.from('recv-key'),
      sasKey: Buffer.from('sas-key'),
    }),
    ...overrides,
  };
}

test('runLanPairing publishes a LAN QR payload and resolves completed key exchange', async () => {
  process.emitWarning = () => {};
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  LanServer.getLanAddresses = () => ['192.168.1.50'];
  const lanServer = new FakeLanServer();
  const calls: string[] = [];
  const cryptoEngine = makeCryptoEngine({
    generateEphemeralKeyPair: () => { calls.push('generate'); },
    deriveSharedSecret: (peerPublicKey: string) => {
      calls.push(`derive:${peerPublicKey}`);
      return Buffer.from('shared-secret');
    },
    deriveSessionKeys: () => {
      calls.push('session-keys');
      return { sendKey: Buffer.from('send-key'), recvKey: Buffer.from('recv-key'), sasKey: Buffer.from('sas-key') };
    },
    setPeerIdentityPublicKey: (peerPublicKey: string) => { calls.push(`identity:${peerPublicKey}`); },
  });

  const pairing = runLanPairing(lanServer as never, cryptoEngine as never, 34567);
  const handler = await waitForHandler(lanServer);

  const response = handler({
    pair_id: 'ignored-by-handler',
    phone_ephemeral_pk: rawKey(2),
    phone_identity_public_key: rawKey(3),
  });

  assert.equal(response.success, true);
  assert.equal(response.pc_name.length > 0, true);
  assert.equal(response.pc_identity_public_key, rawKey(9));

  const result = await pairing;

  assert.equal(result.pair_id, response.pair_id);
  assert.equal(result.phone_identity_public_key, rawKey(3));
  assert.equal(result.session_send_key, Buffer.from('send-key').toString('base64'));
  assert.equal(result.session_recv_key, Buffer.from('recv-key').toString('base64'));
  assert.equal(result.session_sas_key, Buffer.from('sas-key').toString('base64'));
  assert.deepEqual(lanServer.handlerUpdates, [true, false]);
  assert.deepEqual(calls, [
    'generate',
    `derive:${Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.alloc(32, 2)]).toString('base64')}`,
    'session-keys',
    `identity:${rawEd25519ToSpki(rawKey(3))}`,
  ]);
  assert.match(logs.join('\n'), /LAN addresses: 192\.168\.1\.50/);
  assert.match(logs.join('\n'), /Port: 34567/);
});

test('runLanPairing rejects when no LAN address is available', async () => {
  console.log = () => {};
  LanServer.getLanAddresses = () => [];

  await assert.rejects(
    () => runLanPairing(new FakeLanServer() as never, makeCryptoEngine() as never),
    /No LAN network interfaces found/,
  );
});

test('runLanPairing returns failed response and rejects when key exchange fails', async () => {
  process.emitWarning = () => {};
  console.log = () => {};
  LanServer.getLanAddresses = () => ['10.0.0.5'];
  const lanServer = new FakeLanServer();
  const cryptoEngine = makeCryptoEngine({
    deriveSharedSecret: () => {
      throw new Error('bad phone key');
    },
  });

  const pairing = runLanPairing(lanServer as never, cryptoEngine as never);
  const handler = await waitForHandler(lanServer);

  const response = handler({
    pair_id: 'pair-1',
    phone_ephemeral_pk: rawKey(2),
    phone_identity_public_key: rawKey(3),
  });

  assert.deepEqual(response, {
    success: false,
    pair_id: response.pair_id,
    pc_name: response.pc_name,
    pc_identity_public_key: '',
    error: 'bad phone key',
  });
  await assert.rejects(pairing, /Key exchange failed: bad phone key/);
  assert.deepEqual(lanServer.handlerUpdates, [true, false]);
});
