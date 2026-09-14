import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoaaHazardsLayer } from './index.js';

function viewer() {
  const sources = [];
  return {
    sources,
    scene: { requestRender() {} },
    dataSources: {
      add(source) {
        sources.push(source);
      },
      remove(source) {
        sources.splice(sources.indexOf(source), 1);
      },
    },
  };
}
test('NOAA lifecycle draws real provided geometry and dated reports; no fabricated zone geometry', async () => {
  let calls = 0;
  const v = viewer();
  const layer = createNoaaHazardsLayer({
    fetchImpl: async () => {
      calls++;
      return Response.json({
        alerts: [
          {
            id: 'a',
            event: 'Flood Warning',
            title: '<script>x</script>',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-80, 30],
                  [-79, 30],
                  [-79, 31],
                  [-80, 30],
                ],
              ],
            },
            expires: '2099-01-01',
          },
          {
            id: 'b',
            event: 'Heat Advisory',
            geometry: null,
            expires: '2099-01-01',
          },
        ],
        reports: [
          {
            id: 'c',
            kind: 'wind',
            latitude: 35,
            longitude: -95,
            time: '2026-09-13T13:00:00Z',
            place: 'Test',
          },
        ],
        reportDay: '2026-09-13',
        sources: {
          nws: { status: 'ready', fetchedAt: 1 },
          spc: { status: 'ready', fetchedAt: 2 },
        },
        unmappedAlerts: 1,
      });
    },
  });
  await layer.init(v);
  assert.equal(calls, 0);
  assert.equal(v.sources[0].show, false);
  layer.enable();
  await layer.update();
  assert.equal(v.sources[0].entities.values.length, 2);
  assert.ok(v.sources[0].entities.values[0].polygon);
  assert.equal(layer.getStats().unmappedAlerts, 1);
  assert.equal(layer.getStats().count, 3);
  layer.disable();
  assert.equal(v.sources[0].show, false);
  layer.destroy(v);
  assert.equal(v.sources.length, 0);
});

test('disabling a NOAA layer aborts and discards an in-flight refresh', async () => {
  let resolve, signal;
  const v = viewer();
  const layer = createNoaaHazardsLayer({
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  await layer.init(v);
  layer.enable();
  const task = layer.update();
  layer.disable();
  assert.equal(signal.aborted, true);
  resolve(Response.json({ alerts: [], reports: [], sources: {} }));
  assert.equal(await task, false);
  assert.equal(layer.getStats().lastUpdate, null);
  layer.destroy(v);
});

test('NOAA cleans up a data source whose asynchronous add settles after destroy', async () => {
  let release;
  const sources = [];
  const v = {
    scene: { requestRender() {} },
    dataSources: {
      add(source) {
        return new Promise((resolve) => {
          release = () => {
            sources.push(source);
            resolve(source);
          };
        });
      },
      remove(source) {
        const index = sources.indexOf(source);
        if (index >= 0) sources.splice(index, 1);
      },
    },
  };
  const layer = createNoaaHazardsLayer();
  const initialization = layer.init(v);
  layer.destroy();
  release();
  await initialization;
  assert.equal(sources.length, 0);
});

test('NOAA refresh honors manager cancellation without a false error or late repaint', async () => {
  let resolve, signal;
  const v = viewer();
  const manager = new AbortController();
  const layer = createNoaaHazardsLayer({
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  await layer.init(v);
  layer.enable();
  const task = layer.update(v, { signal: manager.signal });
  manager.abort();
  assert.equal(signal.aborted, true);
  resolve(Response.json({ alerts: [], reports: [], sources: {} }));
  assert.equal(await task, false);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().loading, false);
  layer.destroy();
});

test('NOAA removes expired alerts during an outage while retaining explicitly dated reports', async () => {
  const v = viewer();
  let now = Date.parse('2026-09-14T15:00:00Z'),
    fail = false;
  const layer = createNoaaHazardsLayer({
    now: () => now,
    fetchImpl: async () => {
      if (fail) return new Response('', { status: 503 });
      return Response.json({
        alerts: [
          {
            id: 'a',
            event: 'Flood Warning',
            expires: '2026-09-14T15:01:00Z',
            geometry: { type: 'Point', coordinates: [-80, 30] },
          },
        ],
        reports: [
          {
            id: 'report',
            kind: 'wind',
            latitude: 35,
            longitude: -95,
            time: '2026-09-13T13:00:00Z',
          },
        ],
        sources: {
          nws: { status: 'ready', fetchedAt: now },
          spc: { status: 'ready', fetchedAt: now },
        },
        reportDay: '2026-09-13',
      });
    },
  });
  await layer.init(v);
  layer.enable();
  await layer.update();
  assert.equal(v.sources[0].entities.values.length, 2);
  now += 120000;
  fail = true;
  await layer.update();
  assert.equal(v.sources[0].entities.values.length, 1);
  assert.equal(v.sources[0].entities.values[0].id, 'report');
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().stale, true);
  layer.destroy();
});
