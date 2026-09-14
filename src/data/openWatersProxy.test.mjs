import test from 'node:test';
import assert from 'node:assert/strict';
import { openWatersProxy } from '../../server/providers/vessels/open-waters.js';

const now = Date.parse('2026-09-14T12:00:00Z');
const collection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 51] },
      properties: {
        mmsi: 232123456,
        name: 'TEST',
        seen: '2026-09-14T11:59:59Z',
        sog: 5,
      },
    },
  ],
};
function install(plugin, mode = 'configureServer') {
  let handler;
  plugin[mode]({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/open-waters');
        handler = fn;
      },
    },
  });
  return async (url = '/?lat=51&lon=1', method = 'GET') => {
    const response = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method }, response);
    return response;
  };
}
test('dev and preview use the fixed upstream and bounded query, coalescing cached results', async () => {
  let calls = 0;
  const plugin = openWatersProxy({
    now: () => now,
    aisConfigured: () => false,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://ais.openwaters.io');
      assert.equal(new URL(url).pathname, '/v1/vessels');
      assert.equal(new URL(url).searchParams.get('bbox'), '50,-1,52,3');
      assert.equal(init.redirect, 'error');
      return Response.json(collection);
    },
  });
  const dev = install(plugin),
    preview = install(plugin, 'configurePreviewServer');
  const response = await dev();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.rows.length, 1);
  assert.match(response.body.coverage, /regional/i);
  assert.equal((await preview()).body.rows.length, 1);
  assert.equal(calls, 1);
  assert.equal((await dev('/?url=https://evil.test')).statusCode, 400);
  assert.equal((await dev('/other?lat=51&lon=1')).statusCode, 404);
  assert.equal((await dev('/?lat=91&lon=1')).statusCode, 400);
  assert.equal((await dev('/?lat=51&lon=1', 'POST')).statusCode, 405);
});
test('keyless Portsmouth queries stay within the verified regional window', async () => {
  const local = structuredClone(collection);
  local.features[0].geometry.coordinates = [-1.091, 50.799];
  const run = install(
    openWatersProxy({
      now: () => now,
      aisConfigured: () => false,
      fetchImpl: async (url) => {
        const [south, west, north, east] = new URL(url).searchParams
          .get('bbox')
          .split(',')
          .map(Number);
        // The live keyless service rejected the previous 20-by-20-degree query.
        if (north - south > 2.000001 || east - west > 4.000001)
          return new Response('bbox not allowed for this key\n', {
            status: 400,
          });
        assert.ok(south <= 50.799 && north >= 50.799);
        assert.ok(west <= -1.091 && east >= -1.091);
        return Response.json(local);
      },
    }),
  );
  const response = await run('/?lat=50.799&lon=-1.091');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.rows.length, 1);
});
test('Vite setup hooks do not return the Connect app as a post-hook', () => {
  const plugin = openWatersProxy();
  for (const mode of ['configureServer', 'configurePreviewServer']) {
    let registered = false;
    const connectApp = () => {
      throw new Error('Connect app must not be called as a Vite post-hook');
    };
    const result = plugin[mode]({
      middlewares: {
        use(path, handler) {
          assert.equal(path, '/api/open-waters');
          assert.equal(typeof handler, 'function');
          registered = true;
          return connectApp;
        },
      },
    });
    assert.equal(registered, true);
    assert.equal(result, undefined);
  }
});
test('configured AISStream gets an explicit routing response unless OpenWaters is selected', async () => {
  let calls = 0;
  const run = install(
    openWatersProxy({
      now: () => now,
      aisConfigured: () => true,
      fetchImpl: async () => {
        calls++;
        return Response.json(collection);
      },
    }),
  );
  assert.deepEqual((await run()).body, { provider: 'aisstream' });
  assert.equal(calls, 0);
  assert.equal(
    (await run('/?lat=51&lon=1&provider=openwaters')).body.rows.length,
    1,
  );
});
test('oversized, redirected, malformed and failed upstream data never become successful contacts', async () => {
  for (const response of [
    () => new Response('x', { headers: { 'content-length': '999999999' } }),
    () =>
      new Response('', {
        status: 302,
        headers: { location: 'https://evil.test' },
      }),
    () => Response.json({ error: 'bad' }),
    () => new Response('', { status: 503 }),
  ]) {
    const run = install(
      openWatersProxy({
        now: () => now,
        aisConfigured: () => false,
        fetchImpl: async () => response(),
      }),
    );
    const result = await run();
    assert.equal(result.statusCode, 502);
    assert.deepEqual(result.body.rows, []);
    assert.equal(result.body.status, 'down');
  }
});
test('expired cached positions are pruned rather than restamped on cache hits', async () => {
  let clock = now;
  const old = structuredClone(collection);
  old.features[0].properties.seen = '2026-09-14T11:55:10Z';
  const run = install(
    openWatersProxy({
      now: () => clock,
      aisConfigured: () => false,
      fetchImpl: async () => Response.json(old),
    }),
  );
  assert.equal((await run()).body.rows.length, 1);
  clock += 11_000;
  const result = await run();
  assert.equal(result.body.rows.length, 0);
  assert.equal(result.body.newestPositionAt, null);
  assert.equal(result.body.status, 'empty');
});
test('simultaneous matching requests share one fetch and a third region is refused until a slot frees', async () => {
  const releases = [];
  let calls = 0;
  const run = install(
    openWatersProxy({
      now: () => now,
      aisConfigured: () => false,
      fetchImpl: async () => {
        calls++;
        await new Promise((resolve) => releases.push(resolve));
        return Response.json(collection);
      },
    }),
  );
  const first = run('/?lat=51&lon=1');
  const duplicate = run('/?lat=51&lon=1');
  const second = run('/?lat=52&lon=1');
  assert.equal(calls, 2);
  const busy = await run('/?lat=53&lon=1');
  assert.equal(busy.statusCode, 429);
  assert.equal(busy.headers['Retry-After'], '30');
  releases.splice(0).forEach((resolve) => resolve());
  for (const response of await Promise.all([first, duplicate, second])) {
    assert.equal(response.statusCode, 200);
  }
  const next = run('/?lat=53&lon=1');
  assert.equal(calls, 3);
  releases.splice(0).forEach((resolve) => resolve());
  assert.equal((await next).statusCode, 200);
});
