import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderHealthRows } from './providerHealth.js';

test('moving away from a feed region does not present its old success as live coverage', () => {
  const rows = buildProviderHealthRows(
    [
      {
        id: 'transit',
        enabled: true,
        stats: {
          status: 'zoom-in',
          count: 0,
          lastUpdate: 99000,
          coverage: 'No feed here yet',
        },
      },
    ],
    100000,
  );
  assert.equal(rows[0].label, 'WAITING');
});

test('health distinguishes live data, empty success, unknown and missing credentials', () => {
  const rows = buildProviderHealthRows(
    [
      {
        id: 'live',
        enabled: true,
        stats: { status: 'live', count: 2, lastUpdate: 99000 },
      },
      {
        id: 'empty',
        enabled: true,
        stats: { status: 'live', count: 0, lastUpdate: 99000 },
      },
      { id: 'unknown', enabled: true, stats: {} },
      {
        id: 'key',
        enabled: true,
        stats: { status: 'unavailable', keyRequired: true },
      },
      { id: 'off', enabled: false, stats: { keyRequired: true } },
    ],
    100000,
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    ['LIVE', 'LIVE', 'WAITING', 'KEY REQUIRED', 'OFF'],
  );
  assert.equal(rows[1].count, 0);
  assert.equal(rows[2].count, null);
  assert.equal(rows[0].updated, 'just now');
});

test('health reflects stale and degraded errors with manager lifecycle and retry ages', () => {
  const rows = buildProviderHealthRows(
    [
      {
        id: 'old',
        enabled: true,
        stats: { status: 'stale', count: 10, lastUpdate: 40000 },
      },
      {
        id: 'failed',
        enabled: true,
        stats: {
          count: 3,
          lastUpdate: 99000,
          managerRefreshError: 'timeout',
          retryAt: 110000,
        },
      },
      { id: 'starting', enabled: false, lifecycleState: 'enabling', stats: {} },
      { id: 'disabled', enabled: false, stats: { status: 'live', count: 10 } },
    ],
    100000,
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    ['STALE', 'DEGRADED', 'LOADING', 'OFF'],
  );
  assert.equal(rows[0].updated, '1m ago');
  assert.equal(rows[1].retryInSec, 10);
  assert.equal(rows[1].detail, 'timeout');
});

test('health retains independent child feed failures and suppresses hidden layers', () => {
  const rows = buildProviderHealthRows(
    [
      null,
      { id: 'hidden', showInTogglePanel: false },
      {
        id: 'transit',
        name: 'Transit',
        enabled: true,
        stats: {
          status: 'live',
          lastUpdate: 99000,
          feedHealth: [
            {
              id: 'mbta',
              name: 'Boston',
              source: 'MBTA',
              status: 'unavailable',
              error: 'HTTP 503',
            },
          ],
        },
      },
    ],
    100000,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'Boston');
  assert.equal(rows[1].label, 'UNAVAILABLE');
  assert.equal(rows[1].parentId, 'transit');
});
