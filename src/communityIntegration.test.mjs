import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
} from './data/layerState.js';
import {
  registerSpriteCollection,
  unregisterSpriteCollection,
  restoreSpriteOrder,
} from './data/spriteOrder.js';

test('saved/share state retains transit and NOAA while preserving existing CCTV', () => {
  const params = new URLSearchParams('v=2');
  encodeLayerStateParams(params, {
    ...createDefaultLayerState(),
    enabledLayerIds: ['cctv', 'transit', 'noaa-hazards'],
  });
  assert.deepEqual(decodeLayerStateParams(params).enabledLayerIds, [
    'cctv',
    'noaa-hazards',
    'transit',
  ]);
});

test('new transit sprites render above bikeshare and below aircraft regardless of activation order', () => {
  const ids = ['flights', 'transit', 'bikeshare'];
  const collections = Object.fromEntries(ids.map((id) => [id, { id }]));
  const items = ids.map((id) => collections[id]);
  const primitives = {
    contains: (c) => items.includes(c),
    raiseToTop: (c) => {
      items.splice(items.indexOf(c), 1);
      items.push(c);
    },
  };
  try {
    for (const id of ids) registerSpriteCollection(id, collections[id]);
    restoreSpriteOrder({ scene: { primitives } });
    assert.deepEqual(
      items.map((item) => item.id),
      ['bikeshare', 'transit', 'flights'],
    );
  } finally {
    for (const id of ids) unregisterSpriteCollection(id, collections[id]);
  }
});
