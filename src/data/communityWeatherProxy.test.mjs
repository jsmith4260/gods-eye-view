import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weatherForecastProxy,
  noaaHazardsProxy,
} from '../../server/providers/community-weather.js';

function routes(plugin, hook = 'configureServer') {
  const handlers = new Map();
  plugin[hook]({
    middlewares: {
      use(path, handler) {
        handlers.set(path, handler);
      },
    },
  });
  return handlers;
}
async function request(handler, url = '/', method = 'GET') {
  let status, headers, body;
  await handler(
    { url, method, socket: { remoteAddress: '127.0.0.1' } },
    {
      writeHead(code, values) {
        status = code;
        headers = values;
      },
      end(value) {
        body = JSON.parse(value);
      },
    },
  );
  return { status, headers, body };
}
const forecast = {
  timezone: 'UTC',
  current: { temperature_2m: 10 },
  daily: { time: ['2026-09-14'] },
};

test('forecast and NOAA install identical dev/preview routes without fetching at construction', () => {
  for (const factory of [weatherForecastProxy, noaaHazardsProxy]) {
    let calls = 0;
    const plugin = factory({
      fetchImpl: () => {
        calls++;
      },
    });
    assert.deepEqual(
      [...routes(plugin).keys()],
      [...routes(plugin, 'configurePreviewServer').keys()],
    );
    assert.equal(calls, 0);
  }
});

test('Connect middleware registration cannot accidentally become a Vite post-hook', () => {
  for (const factory of [weatherForecastProxy, noaaHazardsProxy]) {
    const plugin = factory();
    for (const hook of ['configureServer', 'configurePreviewServer']) {
      const connect = () => {};
      assert.equal(
        plugin[hook]({ middlewares: { use: () => connect } }),
        undefined,
      );
    }
  }
});

test('forecast rejects invalid inputs/methods, blocks arbitrary URLs and caches coordinates', async () => {
  const calls = [];
  const plugin = weatherForecastProxy({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json(forecast);
    },
  });
  const handler = routes(plugin).get('/api/weather/forecast');
  assert.equal((await request(handler, '?latitude=&longitude=0')).status, 400);
  assert.equal(
    (await request(handler, '?latitude=0&longitude=0', 'POST')).status,
    405,
  );
  assert.equal(
    (await request(handler, '?latitude=0&longitude=0&url=http://localhost'))
      .status,
    400,
  );
  assert.equal((await request(handler, '?latitude=0&longitude=0')).status, 200);
  assert.equal(
    (await request(handler, '?latitude=0&longitude=0')).body.status,
    'cached',
  );
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'api.open-meteo.com');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);
});

test('upstream oversized bodies fail without retaining unlimited cache data', async () => {
  const plugin = weatherForecastProxy({
    fetchImpl: async () =>
      new Response('x', { headers: { 'content-length': '99999999' } }),
  });
  assert.equal(
    (
      await request(
        routes(plugin).get('/api/weather/forecast'),
        '?latitude=0&longitude=0',
      )
    ).status,
    503,
  );
});

test('NOAA independent failure retains active alerts and clearly marks SPC unavailable', async () => {
  const calls = [];
  const plugin = noaaHazardsProxy({
    now: () => Date.parse('2026-09-14T15:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('spc.noaa.gov'))
        return new Response('Unavailable', { status: 503 });
      return Response.json({ features: [] });
    },
  });
  const result = await request(routes(plugin).get('/api/noaa/hazards'));
  assert.equal(result.status, 200);
  assert.equal(result.body.sources.nws.status, 'ready');
  assert.equal(result.body.sources.spc.status, 'unavailable');
  assert.equal(result.body.reportDay, '2026-09-13');
  assert.match(
    calls.find((c) => c.url.includes('spc')).url,
    /260913_rpts\.csv$/,
  );
  assert.ok(calls.every((c) => c.options.redirect === 'error'));
});

test('NOAA returns unavailable if both providers fail, rejects malformed coordinates', async () => {
  const plugin = noaaHazardsProxy({
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  const handler = routes(plugin).get('/api/noaa/hazards');
  assert.equal((await request(handler, '?latitude=3')).status, 400);
  assert.equal((await request(handler)).status, 503);
});

test('search is bounded to five valid locations and does not pass arbitrary options upstream', async () => {
  const plugin = weatherForecastProxy({
    fetchImpl: async () =>
      Response.json({
        results: Array.from({ length: 12 }, (_, i) => ({
          name: `Town ${i}`,
          latitude: 40,
          longitude: 10,
        })),
      }),
  });
  const handler = routes(plugin).get('/api/weather/search');
  assert.equal((await request(handler, '?name=x')).status, 400);
  assert.equal(
    (await request(handler, '?name=Town&url=http://localhost')).status,
    400,
  );
  assert.equal((await request(handler, '?name=Town')).body.results.length, 5);
});

test('weather requests coalesce and stale fallback expires instead of being relabelled fresh', async () => {
  let now = 0,
    release,
    calls = 0,
    fail = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const plugin = weatherForecastProxy({
    now: () => now,
    fetchImpl: async () => {
      calls++;
      await gate;
      if (fail) throw new Error('Offline');
      return Response.json(forecast);
    },
  });
  const handler = routes(plugin).get('/api/weather/forecast');
  const first = request(handler, '?latitude=1&longitude=2');
  const second = request(handler, '?latitude=1&longitude=2');
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  fail = true;
  now = 6 * 60000;
  const stale = await request(handler, '?latitude=1&longitude=2');
  assert.equal(stale.body.status, 'stale');
  assert.equal(stale.body.fetchedAt, 0);
  now = 31 * 60000;
  assert.equal((await request(handler, '?latitude=1&longitude=2')).status, 503);
});

test('expired NWS alerts disappear even when cached payload is served during failure', async () => {
  let now = Date.parse('2026-09-14T15:00:00Z'),
    fail = false;
  const plugin = noaaHazardsProxy({
    now: () => now,
    fetchImpl: async (url) => {
      if (String(url).includes('spc.noaa.gov'))
        return new Response(
          'Time,F_Scale,Location,County,State,Lat,Lon,Comments\n',
        );
      if (fail) throw new Error('Offline');
      return Response.json({
        features: [
          {
            id: 'one',
            properties: {
              status: 'Actual',
              event: 'Flood Warning',
              expires: '2026-09-14T15:01:00Z',
            },
          },
        ],
      });
    },
  });
  const handler = routes(plugin).get('/api/noaa/hazards');
  assert.equal((await request(handler)).body.alerts.length, 1);
  now += 2 * 60000;
  fail = true;
  const stale = await request(handler);
  assert.equal(stale.body.sources.nws.status, 'stale');
  assert.equal(stale.body.alerts.length, 0);
});

test('oversized chunked responses are rejected even without a content-length header', async () => {
  const plugin = weatherForecastProxy({
    fetchImpl: async () => new Response('x'.repeat(300000)),
  });
  assert.equal(
    (
      await request(
        routes(plugin).get('/api/weather/forecast'),
        '?latitude=0&longitude=0',
      )
    ).status,
    503,
  );
});
