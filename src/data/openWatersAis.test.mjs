import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenWatersSnapshot,
  regionalVesselBoxes,
} from './openWatersAis.js';

const now = Date.parse('2026-09-14T12:00:00Z');
const feature = (
  mmsi = '232123456',
  properties = {},
  coordinates = [1, 51],
) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    mmsi,
    name: 'TEST SHIP',
    seen: '2026-09-14T11:59:00Z',
    sog: 5,
    cog: 90,
    heading: 511,
    type: 70,
    nav_status: 0,
    callsign: 'TEST',
    imo: '1234567',
    ...properties,
  },
});
const payload = (...features) => ({ type: 'FeatureCollection', features });
const boxes = [{ south: 50, west: 0, north: 52, east: 2 }];

test('OpenWaters rejects invalid coordinates, identities, expired/future/unknown times and out-of-window data', () => {
  const result = normalizeOpenWatersSnapshot(
    payload(
      feature(),
      feature('bad'),
      feature('232123457', {}, [null, 51]),
      feature('232123458', {}, [181, 51]),
      feature('232123459', {}, [8, 51]),
      feature('232123460', { seen: null }),
      feature('232123461', { seen: '2026-09-14T11:00:00Z' }),
      feature('232123462', { seen: '2026-09-14T12:20:00Z' }),
    ),
    { now, boxes },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].heading, null);
  assert.equal(result.rows[0].navStatus, 0);
  assert.equal(result.rows[0].callsign, 'TEST');
  assert.equal(result.rows[0].last_position_epoch, now / 1000 - 60);
  assert.equal(result.rejectedCount, 7);
  assert.equal(result.status, 'live');
});

test('OpenWaters deduplicates by newest observation and caps fresh contacts', () => {
  const result = normalizeOpenWatersSnapshot(
    payload(
      feature(),
      feature('232123456', { name: 'NEW', seen: '2026-09-14T11:59:50Z' }),
      feature('232123457'),
      feature('232123458'),
    ),
    { now, boxes, maxRows: 2 },
  );
  assert.deepEqual(
    result.rows.map((row) => row.mmsi),
    ['232123456', '232123457'],
  );
  assert.equal(result.rows[0].name, 'NEW');
  assert.equal(result.truncated, true);
  assert.equal(result.rows[0].expiresAtMs, now + 290_000);
});

test('empty and malformed collections are distinct, never fabricated positions', () => {
  assert.equal(
    normalizeOpenWatersSnapshot(payload(), { now, boxes }).status,
    'empty',
  );
  assert.throws(
    () => normalizeOpenWatersSnapshot({}, { now, boxes }),
    /Malformed/,
  );
  assert.throws(
    () => normalizeOpenWatersSnapshot({ features: [] }, { now, boxes }),
    /Malformed/,
  );
});

test('regional boxes are bounded and split at the dateline rather than wrapping through the world', () => {
  assert.deepEqual(regionalVesselBoxes(0, 179), [
    { south: -1, north: 1, west: 177, east: 180 },
    { south: -1, north: 1, west: -180, east: -179 },
  ]);
  assert.deepEqual(regionalVesselBoxes(89, 0), [
    { south: 88, north: 90, west: -2, east: 2 },
  ]);
  assert.deepEqual(regionalVesselBoxes(-89.5, -179), [
    { south: -90, north: -88.5, west: 179, east: 180 },
    { south: -90, north: -88.5, west: -180, east: -177 },
  ]);
  assert.throws(() => regionalVesselBoxes(null, 0), /coordinates/);
  assert.throws(() => regionalVesselBoxes(0, 181), /coordinates/);
});
