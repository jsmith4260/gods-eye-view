import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityVesselSource } from './open-waters.js';

test('the keyless source forwards camera location and preserves observation time, details, and local coverage', async () => {
  const source = createCommunityVesselSource({
    mode: 'openwaters',
    now: () => 1_000_000,
    fetchImpl: async (url) => {
      const query = new URL(url, 'http://localhost').searchParams;
      assert.equal(query.get('lat'), '51');
      assert.equal(query.get('lon'), '1');
      assert.equal(query.get('provider'), 'openwaters');
      return Response.json({
        provider: 'openwaters',
        status: 'live',
        rows: [
          {
            mmsi: '232123456',
            lat: 51,
            lon: 1,
            name: 'TEST',
            last_position_epoch: 900,
            expiresAtMs: 1_200_000,
            callsign: 'ABCD',
            navStatus: 0,
            imo: '1234567',
            provider: 'OpenWaters',
          },
        ],
        coverage: 'regional',
        newestPositionAt: '1970-01-01T00:15:00Z',
      });
    },
  });
  const result = await source.getSnapshot({ latitude: 51, longitude: 1 });
  assert.equal(result.records[0].observedAtMs, 900_000);
  assert.equal(result.records[0].callsign, 'ABCD');
  assert.equal(result.records[0].navStatus, 0);
  assert.equal(result.records[0].expiresAtMs, 1_200_000);
  assert.equal(result.emptyIsValid, true);
  assert.match(result.source, /regional/);
  assert.deepEqual(await source.getTrack('232123456'), {
    records: [],
    complete: false,
  });
});
test('auto delegates snapshot and track to configured AISStream while explicit AISStream bypasses OpenWaters', async () => {
  let count = 0;
  const aisSource = {
    async getSnapshot(query) {
      return { source: 'AISStream', query };
    },
    async getTrack(ref) {
      return ref;
    },
  };
  const source = createCommunityVesselSource({
    aisSource,
    fetchImpl: async () => {
      count++;
      return Response.json({ provider: 'aisstream' });
    },
  });
  assert.equal((await source.getSnapshot({ maxRows: 10 })).source, 'AISStream');
  assert.equal(await source.getTrack('232123456'), '232123456');
  const direct = createCommunityVesselSource({
    mode: 'aisstream',
    aisSource,
    fetchImpl: async () => {
      throw Error('Must not request');
    },
  });
  assert.equal((await direct.getSnapshot()).source, 'AISStream');
  assert.equal(count, 1);
});
test('a bad provider response fails closed and expired contacts are absent', async () => {
  const source = createCommunityVesselSource({
    now: () => 1000,
    fetchImpl: async () =>
      Response.json({
        provider: 'openwaters',
        rows: [{ mmsi: '232123456', lat: 51, lon: 1, expiresAtMs: 999 }],
      }),
  });
  assert.deepEqual((await source.getSnapshot()).records, []);
  const bad = createCommunityVesselSource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(bad.getSnapshot(), /Malformed/);
});

test('an explicit legacy AIS URL remains the default source without a local key or routing probe', async () => {
  for (const aisApiUrl of [
    '/legacy-ais',
    'https://ais.example.test/positions',
  ]) {
    const calls = [];
    const source = createCommunityVesselSource({
      aisApiUrl,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return Response.json({ rows: [], status: 'live' });
      },
    });
    const snapshot = await source.getSnapshot({ maxRows: 42 });
    assert.equal(snapshot.source, 'AISStream');
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0]).pathname,
      new URL(aisApiUrl, 'http://localhost').pathname,
    );
    assert.equal(new URL(calls[0]).searchParams.get('maxRows'), '42');
  }
});

test('explicit source selection overrides a custom AIS URL, including explicit automatic mode', async () => {
  for (const mode of ['openwaters', 'auto']) {
    const calls = [];
    const source = createCommunityVesselSource({
      mode,
      aisApiUrl: '/legacy-ais',
      fetchImpl: async (url) => {
        calls.push(String(url));
        return Response.json({ provider: 'openwaters', rows: [] });
      },
    });
    assert.match((await source.getSnapshot()).source, /OpenWaters/);
    const url = new URL(calls[0], 'http://localhost');
    assert.equal(url.pathname, '/api/open-waters');
    assert.equal(
      url.searchParams.get('provider'),
      mode === 'openwaters' ? 'openwaters' : null,
    );
  }
});

test('automatic mode publishes resolved AISStream attribution even when its initial snapshot fails', async () => {
  const source = createCommunityVesselSource({
    aisSource: {
      label: 'AISStream',
      async getSnapshot() {
        throw new Error('AISStream key rejected');
      },
    },
    fetchImpl: async () => Response.json({ provider: 'aisstream' }),
  });
  await assert.rejects(source.getSnapshot(), /key rejected/);
  assert.equal(source.label, 'AISStream');
});

test('automatic mode publishes an explicit OpenWaters provider failure without pretending routing is unknown', async () => {
  const source = createCommunityVesselSource({
    fetchImpl: async () =>
      Response.json(
        { provider: 'openwaters', rows: [], status: 'down' },
        { status: 502 },
      ),
  });
  await assert.rejects(source.getSnapshot(), /OpenWaters HTTP 502/);
  assert.match(source.label, /OpenWaters/);
});
