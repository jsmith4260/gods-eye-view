import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForecast,
  formatTemperature,
  normalizeNwsAlerts,
  parseSpcReports,
  completedSpcDay,
  weatherPoint,
} from './communityWeatherModel.js';

const now = Date.parse('2026-09-14T15:00:00Z');
const feature = (overrides = {}) => ({
  id: 'urn:alert:1',
  geometry: null,
  properties: {
    event: 'Flood Warning',
    status: 'Actual',
    headline: '<img src=x>',
    effective: '2026-09-14T10:00:00Z',
    expires: '2026-09-14T20:00:00Z',
    areaDesc: 'Example County',
    ...overrides,
  },
});

test('coordinates reject missing values and remain valid at the equator', () => {
  assert.equal(weatherPoint({ latitude: '', longitude: 0 }), null);
  assert.equal(weatherPoint({ latitude: null, longitude: 0 }), null);
  assert.equal(weatherPoint({ latitude: 91, longitude: 0 }), null);
  assert.deepEqual(weatherPoint({ lat: 0, lon: 0 }), {
    latitude: 0,
    longitude: 0,
  });
});

test('forecast keeps missing weather missing, caps at seven days, and converts C/F locally', () => {
  const data = normalizeForecast({
    timezone: 'Pacific/Auckland',
    current: { time: '2026-09-15T03:00', temperature_2m: null },
    daily: {
      time: Array.from({ length: 8 }, (_, i) => `2026-09-${15 + i}`),
      temperature_2m_max: [12],
      temperature_2m_min: [3],
    },
  });
  assert.equal(data.current.temperature, null);
  assert.equal(data.days.length, 7);
  assert.equal(data.days[1].max, null);
  assert.equal(formatTemperature(null, 'f'), '—');
  assert.equal(formatTemperature(0, 'f'), '32°F');
  assert.equal(formatTemperature(-10, 'c'), '-10°C');
  assert.equal(normalizeForecast({ daily: {} }), null);
});

test('NWS normalization excludes test, cancelled, expired and future alerts but preserves unlocated alerts', () => {
  const result = normalizeNwsAlerts(
    {
      features: [
        feature(),
        feature({ status: 'Test' }),
        feature({ messageType: 'Cancel' }),
        feature({ expires: '2026-09-14T14:00:00Z' }),
        feature({ effective: '2026-09-15T00:00:00Z' }),
      ],
    },
    now,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].title, '<img src=x>');
  assert.equal(result[0].geometry, null);
  assert.equal(result[0].area, 'Example County');
});

test('invalid geometry never produces invented coordinates and duplicate IDs are removed', () => {
  const first = feature();
  first.geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [null, 30],
        [-80, 31],
        [-79, 32],
        [null, 30],
      ],
    ],
  };
  assert.equal(normalizeNwsAlerts({ features: [first, first] }, now).length, 1);
  assert.equal(
    normalizeNwsAlerts({ features: [first] }, now)[0].geometry,
    null,
  );
});

test('SPC reports parse all three categories, quoted commas and time rollover without synthesizing null coordinates', () => {
  const csv =
    'Time,F_Scale,Location,County,State,Lat,Lon,Comments\n2345,UNK,"Town, East",County,TX,30,-97,"Tree, damage"\n' +
    'Time,Speed,Location,County,State,Lat,Lon,Comments\n0105,60,Town,County,TX,30,-97,Wind\n' +
    'Time,Size,Location,County,State,Lat,Lon,Comments\n2000,175,Town,County,TX,30,-97,Hail\n2100,100,Missing,County,TX,,-97,Bad\n';
  const rows = parseSpcReports(csv, '2026-09-13');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['tornado', 'wind', 'hail'],
  );
  assert.equal(rows[0].place, 'Town, East, TX');
  assert.equal(rows[0].description, 'Tree, damage');
  assert.equal(rows[1].time, '2026-09-14T01:05:00.000Z');
  assert.equal(parseSpcReports('<html>Unavailable</html>', '2026-09-13'), null);
});

test('completed SPC day tracks noon UTC and month boundaries', () => {
  assert.equal(
    completedSpcDay(Date.parse('2026-09-14T11:59:59Z')),
    '2026-09-12',
  );
  assert.equal(
    completedSpcDay(Date.parse('2026-09-14T12:00:00Z')),
    '2026-09-13',
  );
  assert.equal(
    completedSpcDay(Date.parse('2026-10-01T00:00:00Z')),
    '2026-09-29',
  );
});
