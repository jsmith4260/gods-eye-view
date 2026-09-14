import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  createTransitMiddleware,
  transitProxy,
  readTransitBytes,
  isTransitRedirectAllowed,
} from '../../server/providers/transit.js';

function feedBytes(timestamp = 1_800_000_000) {
  const pbf = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, timestamp);
  pbf.writeBytesField(1, header.finish());
  return pbf.finish();
}
function invoke(middleware, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    Promise.resolve(middleware({ url, method }, res)).catch(reject);
  });
}
test('transit routes reject URL injection and methods without fetching', async () => {
  let calls = 0;
  const middleware = createTransitMiddleware({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  for (const route of [
    '/vehicles/nope',
    '/vehicles/mbta?url=https://evil.test',
    '/vehicles/%2e%2e',
    '/vehicles/mbta/extra',
    '/vehicles/https%3A%2F%2Fevil.test',
  ])
    assert.equal((await invoke(middleware, route)).status, 404);
  assert.equal(
    (await invoke(middleware, '/vehicles/mbta', 'POST')).status,
    405,
  );
  assert.equal((await invoke(middleware, '/feeds')).body.feeds.length, 7);
  assert.equal(calls, 0);
});
test('dev and preview both mount transit middleware', () => {
  const plugin = transitProxy();
  for (const method of ['configureServer', 'configurePreviewServer']) {
    let route;
    plugin[method]({
      middlewares: {
        use(path, handler) {
          route = path;
          assert.equal(typeof handler, 'function');
        },
      },
    });
    assert.equal(route, '/api/transit');
  }
});

test('middleware registration never leaks Connect as a Vite post-install hook', () => {
  const plugin = transitProxy();
  for (const method of ['configureServer', 'configurePreviewServer']) {
    const connect = () => {
      throw new Error('Connect must not be invoked as a post hook');
    };
    const server = {
      middlewares: {
        use() {
          return connect;
        },
      },
    };
    assert.equal(plugin[method](server), undefined);
  }
});
test('redirect allowlist rejects HTTPS arbitrary hosts, localhost, credentials, and changed paths', () => {
  const original = 'https://cdn.mbta.com/realtime/VehiclePositions.pb';
  for (const url of [
    'https://127.0.0.1/',
    'https://example.com/',
    'http://cdn.mbta.com/realtime/VehiclePositions.pb',
    'https://user:pass@cdn.mbta.com/realtime/VehiclePositions.pb',
    'https://cdn.mbta.com/private',
  ])
    assert.equal(
      isTransitRedirectAllowed(url, { id: 'mbta', url: original }),
      false,
    );
  assert.equal(
    isTransitRedirectAllowed(original, { id: 'mbta', url: original }),
    true,
  );
  assert.equal(
    isTransitRedirectAllowed(
      'https://data.texas.gov/api/views/eiei-9rpf/files/d60f7114-6b8f-4389-abd6-af617e018019?filename=vehiclepositions.pb',
      {
        id: 'capmetro-austin',
        url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
      },
    ),
    true,
  );
});
test('transit body cap applies without content length and abort covers stalled body', async () => {
  const oversized = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    }),
  );
  await assert.rejects(
    readTransitBytes(oversized, 4, new AbortController().signal),
    /too large/,
  );
  const abort = new AbortController();
  const stalled = new Response(new ReadableStream({ start() {} }));
  const pending = readTransitBytes(stalled, 100, abort.signal);
  abort.abort();
  await assert.rejects(pending, /abort/i);
});
test('cache coalesces concurrent refresh and stale data expires while failures stay isolated', async () => {
  let now = 1_800_000_000_000,
    calls = 0,
    fail = false;
  const middleware = createTransitMiddleware({
    now: () => now,
    fetchImpl: async () => {
      calls++;
      await Promise.resolve();
      if (fail) throw new Error('offline');
      return new Response(feedBytes());
    },
  });
  const responses = await Promise.all([
    invoke(middleware, '/vehicles/mbta'),
    invoke(middleware, '/vehicles/mbta'),
  ]);
  assert.equal(calls, 1);
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(
    (await invoke(middleware, '/vehicles/mbta')).headers['X-GEV-Cache'],
    'HIT',
  );
  now += 16_000;
  fail = true;
  assert.equal(
    (await invoke(middleware, '/vehicles/mbta')).headers['X-GEV-Cache'],
    'STALE-ERROR',
  );
  assert.equal(
    (await invoke(middleware, '/vehicles/hsl-helsinki')).status,
    502,
  );
  now += 601_000;
  assert.equal((await invoke(middleware, '/vehicles/mbta')).status, 502);
  fail = false;
  now += 16_000;
  assert.equal(
    (await invoke(middleware, '/vehicles/hsl-helsinki')).status,
    200,
  );
});
test('redirect is checked before a second network request', async () => {
  let calls = 0;
  const middleware = createTransitMiddleware({
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private' },
      });
    },
  });
  assert.equal((await invoke(middleware, '/vehicles/mbta')).status, 502);
  assert.equal(calls, 1);
});
