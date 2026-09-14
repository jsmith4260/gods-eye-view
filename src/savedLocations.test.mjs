import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './data/manager.js';
import { LAYER_STATE_REGISTRY } from './data/layerState.js';
import {
  normalizeSavedLocation,
  loadSavedLocations,
  persistSavedLocations,
  upsertSavedLocation,
  removeSavedLocation,
  captureSavedLayers,
  restoreSavedLayers,
} from './savedLocations.js';

const camera = {
  lat: 30,
  lon: -97,
  alt: 900,
  heading: 20,
  pitch: -30,
  roll: 0,
};
const view = {
  id: 'a',
  name: ' Austin ',
  camera,
  mapStack: 'osm',
  createdAt: 1000,
};
function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
}

test('saved views round-trip camera, map and bounded layer options without extra fields', () => {
  const store = storage();
  const row = normalizeSavedLocation({
    ...view,
    secret: 'discard',
    layerState: {
      enabledLayerIds: ['cctv', 'flights', 'made-up'],
      options: {
        flights: { models3d: false },
        cctv: { calibration: 'discard' },
      },
    },
  });
  assert.equal(row.name, 'Austin');
  assert.deepEqual(row.camera, camera);
  assert.equal(row.secret, undefined);
  assert.deepEqual(row.layerState.enabledLayerIds, ['cctv', 'flights']);
  assert.equal(row.layerState.options.flights.models3d, false);
  assert.equal(row.layerState.options.cctv.calibration, undefined);
  assert.equal(persistSavedLocations([row], store), true);
  assert.deepEqual(loadSavedLocations(store), [row]);
});

test('invalid coordinates, coercible nonnumbers and unreasonable camera state are rejected', () => {
  for (const patch of [
    { lat: 91 },
    { lon: 181 },
    { lat: null },
    { alt: Infinity },
    { lat: '30' },
    { pitch: 200 },
    { alt: -1 },
  ]) {
    assert.equal(
      normalizeSavedLocation({ ...view, camera: { ...camera, ...patch } }),
      null,
    );
  }
  assert.equal(normalizeSavedLocation({ ...view, name: '  ' }), null);
  assert.equal(
    normalizeSavedLocation({ ...view, mapStack: 'javascript:alert(1)' })
      .mapStack,
    null,
  );
});

test('storage fails honestly and invalid or oversized persisted data is ignored', () => {
  assert.equal(persistSavedLocations([view], null), false);
  assert.equal(
    persistSavedLocations([view], {
      setItem() {
        throw new Error('quota');
      },
    }),
    false,
  );
  for (const raw of ['not json', '{}', 'x'.repeat(250_000)])
    assert.deepEqual(loadSavedLocations({ getItem: () => raw }), []);
  assert.deepEqual(
    loadSavedLocations({
      getItem() {
        throw new Error('denied');
      },
    }),
    [],
  );
});

test('upserts replace matching ids, discard corrupt entries, cap at 24 and delete exact ids', () => {
  let rows = [];
  for (let i = 0; i < 26; i++)
    rows = upsertSavedLocation(rows, { ...view, id: String(i) });
  assert.equal(rows.length, 24);
  rows = upsertSavedLocation([null, ...rows], {
    ...view,
    id: '25',
    name: 'Updated',
  });
  assert.equal(rows.length, 24);
  assert.equal(rows[0].name, 'Updated');
  assert.equal(removeSavedLocation(rows, '25').length, 23);
});

test('captured layer state excludes transient tracking selection and preserves visual options', () => {
  const manager = {
    getEnabledLayerIds: () => new Set(['flights']),
    getLayerParams: (id) =>
      id === 'flights'
        ? { models3d: false, selectedFlightsTrackingId: 'abc123' }
        : null,
  };
  const state = captureSavedLayers(manager);
  assert.deepEqual(state.enabledLayerIds, ['flights']);
  assert.equal(state.options.flights.models3d, false);
  assert.equal(state.options.flights.selectedFlightsTrackingId, null);
});

test('restore updates options and reports individual failures without rejecting all layers', async () => {
  const manager = new DataLayerManager({});
  let options = { models3d: true },
    blocked = true;
  manager.register({
    id: 'flights',
    name: 'Flights',
    updateInterval: -1,
    init() {
      options = { models3d: true };
    },
    setParams(value) {
      options = { ...options, ...value };
      return true;
    },
    getParams() {
      return options;
    },
    enable() {},
    disable() {},
    update() {},
    getStats() {
      return {};
    },
    destroy() {},
  });
  manager.register({
    id: 'cctv',
    name: 'CCTV',
    updateInterval: -1,
    init() {},
    enable() {},
    disable() {
      if (blocked) {
        blocked = false;
        throw new Error('blocked');
      }
    },
    update() {},
    getStats() {
      return {};
    },
    destroy() {},
  });
  manager.finalizeRegistrations(
    LAYER_STATE_REGISTRY.filter((row) => ['flights', 'cctv'].includes(row.id)),
  );
  await manager.setEnabled('cctv', true);
  const result = await restoreSavedLayers(manager, {
    enabledLayerIds: ['flights'],
    options: { flights: { models3d: false } },
  });
  assert.equal(manager.isEnabled('flights'), true);
  assert.equal(options.models3d, false);
  const store = storage();
  persistSavedLocations(
    [{ ...view, layerState: captureSavedLayers(manager) }],
    store,
  );
  const captured = loadSavedLocations(store)[0];
  assert.ok(captured.layerState.enabledLayerIds.includes('flights'));
  assert.equal(result.find((row) => row.id === 'cctv').succeeded, false);
  await manager.destroyAll();
});
