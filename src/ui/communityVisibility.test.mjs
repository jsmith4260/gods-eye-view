import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCommunityMode } from './communityVisibility.js';

test('entering a mode that hides the panel releases its active work and cleanup detaches observation', () => {
  const classes = new Set();
  let changed,
    disconnected = false,
    closed = 0;
  const body = { classList: { contains: (value) => classes.has(value) } };
  class Observer {
    constructor(callback) {
      changed = callback;
    }
    observe(target, options) {
      assert.equal(target, body);
      assert.deepEqual(options.attributeFilter, ['class']);
    }
    disconnect() {
      disconnected = true;
    }
  }
  const stop = observeCommunityMode(body, () => closed++, Observer);
  changed();
  assert.equal(closed, 0);
  for (const name of ['cockpit-mode', 'recording-mode', 'ui-clean-view']) {
    classes.clear();
    classes.add(name);
    changed();
  }
  assert.equal(closed, 3);
  stop();
  assert.equal(disconnected, true);
  changed();
  assert.equal(closed, 3);
});
