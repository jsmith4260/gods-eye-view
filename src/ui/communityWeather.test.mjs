import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherController,
  createWeatherPanel,
} from './communityWeather.js';

const weather = { current: { temperature: 10 }, days: [], status: 'ready' };
const hazards = {
  alerts: [],
  reports: [],
  sources: { nws: { status: 'ready' }, spc: { status: 'ready' } },
};
test('weather controller remains idle while hidden, refreshes on open and stops polling on close', async () => {
  let calls = 0,
    scheduled = 0,
    cleared = 0;
  const controller = createWeatherController({
    getLocation: () => ({ lat: 40, lon: -70 }),
    fetchImpl: async (url) => {
      calls++;
      return Response.json(url.includes('/forecast') ? weather : hazards);
    },
    setTimer: () => {
      scheduled++;
      return 1;
    },
    clearTimer: () => {
      cleared++;
    },
  });
  assert.equal(calls, 0);
  await controller.setVisible(true);
  assert.equal(calls, 2);
  assert.equal(scheduled, 1);
  controller.setVisible(false);
  assert.equal(cleared, 1);
  controller.destroy();
});

test('a slow old location cannot overwrite the new location or report a false error', async () => {
  const pending = [];
  const rendered = [];
  const controller = createWeatherController({
    getLocation: () => ({ lat: 40, lon: -70 }),
    fetchImpl: (url) =>
      new Promise((resolve) => pending.push({ url, resolve })),
    onChange: (state) => rendered.push(state),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const first = controller.setVisible(true);
  const second = controller.refresh({ lat: 50, lon: 10, label: 'New place' });
  for (const item of pending.slice(2))
    item.resolve(
      Response.json(item.url.includes('/forecast') ? weather : hazards),
    );
  await second;
  for (const item of pending.slice(0, 2))
    item.resolve(
      Response.json(
        item.url.includes('/forecast')
          ? { ...weather, current: { temperature: 99 } }
          : hazards,
      ),
    );
  await first;
  assert.equal(controller.getState().location.latitude, 50);
  assert.equal(controller.getState().forecast.current.temperature, 10);
  assert.equal(rendered.at(-1).error, null);
  controller.destroy();
});

test('partial provider failures preserve successful data and unit change does not refetch', async () => {
  let calls = 0;
  const controller = createWeatherController({
    getLocation: () => ({ lat: 0, lon: 0 }),
    fetchImpl: async (url) => {
      calls++;
      return url.includes('/forecast')
        ? Response.json(weather)
        : new Response('', { status: 503 });
    },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await controller.setVisible(true);
  assert.equal(controller.getState().forecast.current.temperature, 10);
  assert.equal(controller.getState().hazards, null);
  assert.match(controller.getState().error, /NOAA/);
  controller.setUnit('f');
  assert.equal(controller.getState().unit, 'f');
  assert.equal(calls, 2);
  controller.destroy();
});

test('weather panel treats provider text as text and renders missing values without zero coercion', async () => {
  class Element {
    constructor(tag, doc) {
      this.tag = tag;
      this.ownerDocument = doc;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
    }
    set innerHTML(_) {
      throw new Error('HTML rendering is forbidden');
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    }
    remove() {
      this.removed = true;
    }
  }
  const doc = {
    createElement: (tag) => new Element(tag, doc),
    createTextNode: (text) => ({ textContent: text }),
  };
  const container = new Element('div', doc);
  const payload = {
    ...hazards,
    reportDay: '2026-09-13',
    alerts: [
      {
        event: 'Flood Warning',
        title: '<img src=x onerror=alert(1)>',
        description: '<script>bad()</script>',
        expires: '2099-01-01',
      },
    ],
  };
  const panel = createWeatherPanel({
    container,
    getLocation: () => ({ lat: 0, lon: 0, label: '<svg onload=bad()>' }),
    fetchImpl: async (url) =>
      Response.json(
        url.includes('/forecast')
          ? { ...weather, current: { temperature: null } }
          : payload,
      ),
  });
  await panel.setVisible(true);
  const walk = (element) => [
    element,
    ...(element.children || []).flatMap(walk),
  ];
  const elements = walk(container);
  assert.ok(
    elements.some((e) => e.textContent === '<img src=x onerror=alert(1)>'),
  );
  assert.ok(elements.some((e) => e.textContent === '—'));
  assert.equal(
    elements.some((e) => ['img', 'script', 'svg'].includes(e.tag)),
    false,
  );
  panel.destroy();
});
