import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitSource } from '../layers/transit/source.js';

test('browser source rejects unregistered feeds without starting a request', async () => {
  let calls = 0;
  const source = createTransitSource({
    fetchImpl: async () => {
      calls++;
      throw new Error('Unexpected request');
    },
  });
  await assert.rejects(
    source.getSnapshot('https://example.com/'),
    /Unknown transit/,
  );
  assert.equal(calls, 0);
});
test('browser source preserves stale metadata and rejects another region or excessive counts', async () => {
  let payload = { feedId: 'mbta', vehicles: [], stale: true };
  const source = createTransitSource({
    fetchImpl: async () => new Response(JSON.stringify(payload)),
  });
  assert.equal((await source.getSnapshot('mbta')).stale, true);
  payload = { feedId: 'hsl-helsinki', vehicles: [] };
  await assert.rejects(source.getSnapshot('mbta'), /Invalid transit/);
  payload = {
    feedId: 'mbta',
    vehicles: Array.from({ length: 15001 }, () => ({})),
  };
  await assert.rejects(source.getSnapshot('mbta'), /Invalid transit/);
});
test('browser source abort cancels a stalled response body', async () => {
  const abort = new AbortController();
  const source = createTransitSource({
    fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
  });
  const pending = source.getSnapshot('mbta', { signal: abort.signal });
  await Promise.resolve();
  abort.abort();
  await assert.rejects(pending, /abort/i);
});
