import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import transitLayer, {
  createTransitLayer,
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitVehicleKey,
} from './transit.js';
import { TRANSIT_MODES, getTransitFeed } from './transitFeeds.js';

test('layer module declares the manager contract', () => {
  assert.equal(transitLayer.id, 'transit');
  assert.equal(typeof transitLayer.name, 'string');
  assert.equal(typeof transitLayer.icon, 'string');
  assert.equal(transitLayer.updateInterval, TRANSIT_POLL_MS);
  for (const method of [
    'init',
    'enable',
    'disable',
    'update',
    'getStats',
    'destroy',
  ]) {
    assert.equal(
      typeof transitLayer[method],
      'function',
      `${method} is implemented`,
    );
  }
});

test('every transit mode has a colour and the selected card uses it as accent', () => {
  for (const mode of TRANSIT_MODES) {
    assert.match(
      TRANSIT_MODE_COLORS[mode],
      /^#[0-9a-f]{6}$/i,
      `${mode} has a colour`,
    );
  }
  const position = Cesium.Cartesian3.fromDegrees(-71.06, 42.36, 3);
  const card = createTransitSelectedOverlayEntry(
    'mbta:1',
    position,
    { title: 'T', details: ['d'] },
    'subway',
  );
  assert.equal(card.accent, TRANSIT_MODE_COLORS.subway);
  assert.equal(card.selected, true);
  assert.equal(card.protected, true);
  assert.equal(card.position, position);
  assert.equal(
    createTransitSelectedOverlayEntry(
      '',
      position,
      { title: 'T', details: [] },
      'bus',
    ),
    null,
  );
  assert.equal(
    createTransitSelectedOverlayEntry(
      'k',
      null,
      { title: 'T', details: [] },
      'bus',
    ),
    null,
  );
  assert.equal(
    TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS.moving,
    true,
    'the card follows a moving vehicle',
  );
});

test('a vehicle glides linearly from its drawn position to the new fix over one poll', () => {
  const entry = {
    from: { lat: 0, lon: 0 },
    to: { lat: 1, lon: 2 },
    tStart: 1000,
    tEnd: 1000 + TRANSIT_POLL_MS,
  };
  assert.deepEqual(interpolatedVehiclePosition(entry, 500), {
    lat: 0,
    lon: 0,
    settled: false,
  });
  const mid = interpolatedVehiclePosition(entry, 1000 + TRANSIT_POLL_MS / 2);
  assert.ok(Math.abs(mid.lat - 0.5) < 1e-9 && Math.abs(mid.lon - 1) < 1e-9);
  assert.equal(mid.settled, false);
  assert.deepEqual(interpolatedVehiclePosition(entry, 1000 + TRANSIT_POLL_MS), {
    lat: 1,
    lon: 2,
    settled: true,
  });
  // A brand-new vehicle (no `from`) sits exactly on its fix.
  assert.deepEqual(
    interpolatedVehiclePosition(
      { from: null, to: { lat: 5, lon: 6 }, tStart: 0, tEnd: 0 },
      10,
    ),
    { lat: 5, lon: 6, settled: true },
  );
});

test('fixes older than ten minutes or without a valid timestamp are stale', () => {
  const now = 1_700_000_000_000;
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 30 }, now), false);
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 601 }, now), true);
  assert.equal(isStaleVehicleFix({ timestamp: null }, now), true);
  assert.equal(isStaleVehicleFix({}, now), true);
});

test('selection copy reads like a transit card and never leaks nulls', () => {
  const feed = getTransitFeed('metrotransit-msp');
  const now = 1_788_936_960_000;
  const full = buildTransitSelectionCopy(
    feed,
    {
      id: '1557',
      label: '1557',
      routeId: '17',
      lat: 44.9,
      lon: -93.4,
      bearing: 248,
      speedMps: 11.2,
      timestamp: 1_788_936_945,
      stopId: '57458',
      status: 'STOPPED_AT',
      occupancy: 'FEW_SEATS_AVAILABLE',
    },
    'bus',
    now,
  );
  assert.equal(full.title, '🚌 Route 17');
  assert.deepEqual(full.details, [
    'Metro Transit · Minneapolis–St Paul, MN',
    '40 km/h · hdg 248°',
    'Stopped at stop 57458 · few seats available',
    'Vehicle 1557',
    'Reported 15 s ago',
  ]);
  const sparse = buildTransitSelectionCopy(
    feed,
    { id: 'abc', lat: 1, lon: 1 },
    'rail',
    now,
  );
  assert.equal(sparse.title, '🚆 Vehicle abc');
  assert.deepEqual(sparse.details, ['Metro Transit · Minneapolis–St Paul, MN']);
  for (const line of [...full.details, ...sparse.details])
    assert.doesNotMatch(line, /null|undefined|NaN/);
  assert.equal(transitVehicleKey('mbta', '17'), 'mbta:17');
});

test('the layer accepts a manager handle for out-of-tick panel repaints', () => {
  assert.equal(typeof transitLayer.attachDataManager, 'function');
  transitLayer.attachDataManager({ refreshLayerStats() {} });
  transitLayer.attachDataManager(null);
});

test('stats before enable are an honest zero, not a fake feed state', () => {
  const stats = transitLayer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.source, 'GTFS-RT');
  assert.equal(stats.error, null);
});

function sceneFixture() {
  let center = { lat: 42.36, lon: -71.06 };
  const cameraChanged = new Set(),
    preRender = new Set(),
    primitives = new Set();
  const viewer = {
    camera: {
      positionCartographic: { height: 9000 },
      percentageChanged: 0.5,
      changed: {
        addEventListener(fn) {
          cameraChanged.add(fn);
        },
        removeEventListener(fn) {
          cameraChanged.delete(fn);
        },
      },
      computeViewRectangle() {
        return Cesium.Rectangle.fromDegrees(
          center.lon - 0.1,
          center.lat - 0.1,
          center.lon + 0.1,
          center.lat + 0.1,
        );
      },
    },
    scene: {
      globe: {},
      primitives: {
        add(p) {
          primitives.add(p);
          return p;
        },
        remove(p) {
          primitives.delete(p);
          p.destroy();
        },
      },
      preRender: {
        addEventListener(fn) {
          preRender.add(fn);
          return () => preRender.delete(fn);
        },
      },
    },
  };
  const overlays = { setEntries() {}, setVisible() {}, clearSource() {} };
  return {
    viewer,
    overlays,
    cameraChanged,
    preRender,
    primitives,
    move(next) {
      center = next;
    },
    points() {
      return [...primitives][0];
    },
  };
}
function fixtureLayer(source, clock = () => 1_800_000_000_000) {
  const scene = sceneFixture();
  const held = new Set();
  const layer = createTransitLayer({
    source,
    now: clock,
    services: {
      overlays: scene.overlays,
      render: {
        governorRequestRender() {},
        holdContinuousRender(id) {
          held.add(id);
        },
        releaseContinuousRender(id) {
          held.delete(id);
        },
      },
      sprites: { registerSpriteCollection() {}, restoreSpriteOrder() {} },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    },
  });
  layer.init(scene.viewer);
  return { ...scene, layer, held };
}
const currentVehicle = {
  id: '17',
  lat: 42.36,
  lon: -71.06,
  timestamp: 1_800_000_000,
  routeId: 'Red',
};
function snapshot(vehicles = [currentVehicle]) {
  return { feedId: 'mbta', fetchedAt: 1_800_000_000_000, vehicles };
}

test('layer renders validated contacts, isolates instances, and releases scene resources on disable', async () => {
  const fixture = fixtureLayer({
    async getSnapshot() {
      return snapshot([
        currentVehicle,
        { ...currentVehicle, id: 'bad', lat: 999 },
        { ...currentVehicle, id: 'old', timestamp: 10 },
      ]);
    },
  });
  const other = fixtureLayer({
    async getSnapshot() {
      return snapshot();
    },
  });
  fixture.layer.enable(fixture.viewer);
  await fixture.layer.update();
  assert.equal(fixture.layer.getStats().count, 1);
  assert.equal(fixture.points().length, 1);
  assert.equal(other.layer.getStats().count, 0);
  assert.equal(
    fixture.layer.getStats().feedHealth.find((f) => f.id === 'mbta').status,
    'live',
  );
  fixture.layer.disable(fixture.viewer);
  assert.equal(fixture.points().length, 0);
  assert.equal(fixture.cameraChanged.size, 0);
  assert.equal(fixture.preRender.size, 0);
  assert.equal(fixture.held.size, 0);
  fixture.layer.destroy(fixture.viewer);
  other.layer.destroy(other.viewer);
  assert.equal(fixture.primitives.size, 0);
});

test('late source completion after disable cannot repopulate contacts', async () => {
  let resolve, requestSignal;
  const f = fixtureLayer({
    getSnapshot(feedId, { signal }) {
      requestSignal = signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  f.layer.enable(f.viewer);
  const pending = f.layer.update();
  f.layer.disable(f.viewer);
  assert.equal(requestSignal.aborted, true);
  resolve(snapshot());
  await pending;
  assert.equal(f.layer.getStats().count, 0);
  assert.equal(f.points().length, 0);
  f.layer.destroy(f.viewer);
});

test('stale vehicles disappear even while the provider repeatedly fails', async () => {
  let now = 1_800_000_000_000,
    fail = false;
  const f = fixtureLayer(
    {
      async getSnapshot() {
        if (fail) throw new Error('offline');
        return snapshot();
      },
    },
    () => now,
  );
  f.layer.enable(f.viewer);
  await f.layer.update();
  assert.equal(f.layer.getStats().count, 1);
  fail = true;
  now += 601_000;
  await f.layer.update();
  assert.equal(f.layer.getStats().count, 0);
  assert.equal(f.points().length, 0);
  assert.match(f.layer.getStats().error, /unavailable/);
  f.layer.destroy(f.viewer);
});

test('moving to a different covered region removes old contacts and requests that region only', async () => {
  const requested = [];
  const f = fixtureLayer({
    async getSnapshot(id) {
      requested.push(id);
      return id === 'mbta'
        ? snapshot()
        : { feedId: id, fetchedAt: 1_800_000_000_000, vehicles: [] };
    },
  });
  f.layer.enable(f.viewer);
  await f.layer.update();
  f.move({ lat: 60.17, lon: 24.94 });
  await f.layer.update();
  assert.deepEqual([...new Set(requested)], ['mbta', 'hsl-helsinki']);
  assert.equal(f.layer.getStats().count, 0);
  f.layer.destroy(f.viewer);
});

test('an aborted request cannot publish after leaving and returning to the same region', async () => {
  const pending = [];
  const f = fixtureLayer({
    getSnapshot(id) {
      if (id === 'mbta') return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve({
        feedId: id,
        fetchedAt: 1_800_000_000_000,
        vehicles: [],
      });
    },
  });
  f.layer.enable(f.viewer);
  const first = f.layer.update();
  f.move({ lat: 60.17, lon: 24.94 });
  await f.layer.update();
  f.move({ lat: 42.36, lon: -71.06 });
  const second = f.layer.update();
  pending[0](snapshot([{ ...currentVehicle, id: 'obsolete' }]));
  await first;
  assert.equal(f.layer.getStats().count, 0);
  pending[1](snapshot());
  await second;
  assert.equal(f.layer.getStats().count, 1);
  f.layer.destroy(f.viewer);
});

test('unavailable terrain samples are retried while actual zero heights are cached', async () => {
  for (const cold of [undefined, 'throw']) {
    let now = 1_800_000_000_000,
      ready = false,
      calls = 0;
    const f = fixtureLayer(
      {
        async getSnapshot() {
          return snapshot();
        },
      },
      () => now,
    );
    f.viewer.scene.sampleHeightSupported = true;
    f.viewer.scene.sampleHeight = () => {
      calls++;
      if (!ready && cold === 'throw') throw new Error('tiles pending');
      return ready ? 120 : undefined;
    };
    f.layer.enable(f.viewer);
    await f.layer.update();
    ready = true;
    now += 16000;
    await f.layer.update();
    now += 16000;
    for (const render of f.preRender) render();
    assert.equal(calls, 2);
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(f.points().get(0).position).height -
          123,
      ) < 0.01,
    );
    now += 16000;
    await f.layer.update();
    assert.equal(calls, 2);
    f.layer.destroy(f.viewer);
  }
  let now = 1_800_000_000_000,
    calls = 0;
  const f = fixtureLayer(
    {
      async getSnapshot() {
        return snapshot();
      },
    },
    () => now,
  );
  f.viewer.scene.sampleHeightSupported = true;
  f.viewer.scene.sampleHeight = () => {
    calls++;
    return 0;
  };
  f.layer.enable(f.viewer);
  await f.layer.update();
  now += 16000;
  await f.layer.update();
  assert.equal(calls, 1);
  f.layer.destroy(f.viewer);
});

test('manager cancellation reaches transport, refuses late data and permits an immediate retry', async () => {
  const pending = [],
    signals = [];
  const f = fixtureLayer({
    getSnapshot(id, { signal }) {
      signals.push(signal);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  f.layer.enable(f.viewer);
  const controller = new AbortController();
  const first = f.layer.update(f.viewer, { signal: controller.signal });
  controller.abort();
  assert.equal(signals[0].aborted, true);
  pending[0](snapshot());
  await first;
  assert.equal(f.layer.getStats().count, 0);
  assert.equal(f.layer.getStats().loading, false);
  assert.equal(f.layer.getStats().error, null);
  const second = f.layer.update(f.viewer);
  assert.equal(pending.length, 2);
  pending[1](snapshot());
  await second;
  assert.equal(f.layer.getStats().count, 1);
  f.layer.destroy(f.viewer);
});

test('an already cancelled manager update performs no provider work', async () => {
  let calls = 0;
  const f = fixtureLayer({
    async getSnapshot() {
      calls++;
      return snapshot();
    },
  });
  f.layer.enable(f.viewer);
  const controller = new AbortController();
  controller.abort();
  await f.layer.update(f.viewer, { signal: controller.signal });
  assert.equal(calls, 0);
  f.layer.destroy(f.viewer);
});

test('cancellation of a coalesced manager update revokes its shared request', async () => {
  let calls = 0,
    release,
    transportSignal;
  const f = fixtureLayer({
    getSnapshot(id, { signal }) {
      calls++;
      transportSignal = signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  f.layer.enable(f.viewer);
  const first = f.layer.update(f.viewer);
  const controller = new AbortController();
  const second = f.layer.update(f.viewer, { signal: controller.signal });
  controller.abort();
  assert.equal(transportSignal.aborted, true);
  release(snapshot());
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(f.layer.getStats().count, 0);
  assert.equal(f.layer.getStats().loading, false);
  f.layer.destroy(f.viewer);
});

test('stationary snapshots do not hold continuous rendering; moved contacts still glide', async () => {
  let now = 1_800_000_000_000,
    vehicle = { ...currentVehicle };
  const f = fixtureLayer(
    {
      async getSnapshot() {
        return snapshot([vehicle]);
      },
    },
    () => now,
  );
  f.layer.enable(f.viewer);
  await f.layer.update();
  assert.equal(f.held.size, 0);
  now += 16000;
  await f.layer.update();
  assert.equal(f.held.size, 0);
  vehicle = { ...vehicle, lat: vehicle.lat + 0.01 };
  now += 16000;
  await f.layer.update();
  assert.equal(f.held.size, 1);
  now += 7500;
  for (const render of f.preRender) render();
  const midway = Cesium.Math.toDegrees(
    Cesium.Cartographic.fromCartesian(f.points().get(0).position).latitude,
  );
  assert.ok(midway > currentVehicle.lat && midway < vehicle.lat);
  now += 8000;
  for (const render of f.preRender) render();
  assert.equal(f.held.size, 0);
  f.layer.destroy(f.viewer);
});
