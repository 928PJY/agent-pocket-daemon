import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BONJOUR_SERVICE_TYPE } from 'agent-pocket-protocol';
import { BonjourAdvertiser, type BonjourFactory } from '../src/lan/bonjour-advertiser.js';

type PublishOptions = {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
};

test('BonjourAdvertiser publishes service metadata for LAN discovery', async () => {
  const published: PublishOptions[] = [];
  let stopCount = 0;
  let destroyCount = 0;
  const createBonjour: BonjourFactory = () => ({
    publish: (options) => {
      published.push(options);
      return {
        stop: () => {
          stopCount += 1;
        },
      };
    },
    destroy: () => {
      destroyCount += 1;
    },
  });

  const advertiser = new BonjourAdvertiser(31820, 'pair-123', 'MacBook Pro', '1.2.3', createBonjour);

  await advertiser.start();

  assert.deepEqual(published, [{
    name: 'AgentPocket-MacBook Pro',
    type: BONJOUR_SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, ''),
    port: 31820,
    txt: {
      pair_id: 'pair-123',
      version: '1.2.3',
      name: 'MacBook Pro',
    },
  }]);
  assert.equal(stopCount, 0);
  assert.equal(destroyCount, 0);
});

test('BonjourAdvertiser stop is idempotent and cleans up service before bonjour', async () => {
  const calls: string[] = [];
  const createBonjour: BonjourFactory = async () => ({
    publish: () => ({
      stop: () => calls.push('service.stop'),
    }),
    destroy: () => calls.push('bonjour.destroy'),
  });
  const advertiser = new BonjourAdvertiser(31820, 'pair-123', 'MacBook Pro', undefined, createBonjour);

  await advertiser.start();
  advertiser.stop();
  advertiser.stop();

  assert.deepEqual(calls, ['service.stop', 'bonjour.destroy']);
});

test('BonjourAdvertiser rethrows publish setup failures', async () => {
  const err = new Error('mdns unavailable');
  const advertiser = new BonjourAdvertiser(31820, 'pair-123', 'MacBook Pro', undefined, () => {
    throw err;
  });

  await assert.rejects(() => advertiser.start(), err);
});
