// Independent implementation of the public OpenWaters GeoJSON contract.
// Feature inspiration: Gh0st-mods/Gods-Eye-Ghost-Edition @ 2c4de78.
export const OPEN_WATERS_MAX_ROWS = 2000;
export const OPEN_WATERS_MAX_AGE_MS = 5 * 60_000;
export const OPEN_WATERS_COVERAGE =
  'OpenWaters regional AIS observations; receiver coverage is incomplete';

/** A keyless-tested 2 by 4 degree region around the camera, split at the dateline. */
export function regionalVesselBoxes(latitude, longitude) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new Error('Invalid vessel coordinates');
  const vertical = {
    south: Math.max(-90, latitude - 1),
    north: Math.min(90, latitude + 1),
  };
  const west = longitude - 2,
    east = longitude + 2;
  if (east > 180)
    return [
      { ...vertical, west, east: 180 },
      { ...vertical, west: -180, east: east - 360 },
    ];
  if (west < -180)
    return [
      { ...vertical, west: west + 360, east: 180 },
      { ...vertical, west: -180, east },
    ];
  return [{ ...vertical, west, east }];
}
const text = (value, max = 100) =>
  typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, max)
    : '';
const number = (value, min, max) =>
  value !== null &&
  value !== '' &&
  typeof value !== 'boolean' &&
  Number.isFinite(Number(value)) &&
  Number(value) >= min &&
  Number(value) <= max
    ? Number(value)
    : null;

export function normalizeOpenWatersSnapshot(
  payload,
  { now = Date.now(), boxes, maxRows = OPEN_WATERS_MAX_ROWS } = {},
) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features))
    throw new Error('Malformed OpenWaters collection');
  if (!Array.isArray(boxes) || !boxes.length)
    throw new Error('Regional coverage is required');
  const records = new Map();
  let rejectedCount = 0;
  for (const feature of payload.features) {
    const p = feature?.properties;
    const coords = feature?.geometry?.coordinates;
    const lon = coords?.[0],
      lat = coords?.[1];
    const id = String(p?.mmsi ?? feature?.id ?? '');
    const seen = typeof p?.seen === 'string' ? Date.parse(p.seen) : NaN;
    if (
      feature?.geometry?.type !== 'Point' ||
      !Array.isArray(coords) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !/^[1-9]\d{8}$/.test(id) ||
      !Number.isFinite(seen) ||
      seen <= 0 ||
      seen > now + 60_000 ||
      now - seen >= OPEN_WATERS_MAX_AGE_MS ||
      !boxes.some(
        (b) =>
          lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east,
      )
    ) {
      rejectedCount++;
      continue;
    }
    const row = {
      mmsi: id,
      lat,
      lon,
      name: text(p.name) || `MMSI ${id}`,
      type:
        number(p.type, 0, 99) === null
          ? text(p.kind, 40)
          : String(Number(p.type)),
      speed: number(p.sog, 0, 102.2),
      course: number(p.cog, 0, 359.99),
      heading: number(p.heading, 0, 359),
      navStatus: number(p.nav_status, 0, 14),
      destination: text(p.destination),
      callsign: text(p.callsign || p.call_sign, 24),
      imo: text(String(p.imo || p.IMO || ''), 16),
      provider: 'OpenWaters',
      station: text(p.station, 64),
      originSource: text(p.source, 64),
      last_position_epoch: seen / 1000,
      last_position_UTC: new Date(seen).toISOString(),
      expiresAtMs: seen + OPEN_WATERS_MAX_AGE_MS,
    };
    const previous = records.get(id);
    if (!previous || row.last_position_epoch > previous.last_position_epoch)
      records.set(id, row);
  }
  const cap = Number.isFinite(maxRows)
    ? Math.max(1, Math.min(OPEN_WATERS_MAX_ROWS, Math.floor(maxRows)))
    : OPEN_WATERS_MAX_ROWS;
  const rows = [...records.values()]
    .sort(
      (a, b) =>
        b.last_position_epoch - a.last_position_epoch ||
        a.mmsi.localeCompare(b.mmsi),
    )
    .slice(0, cap);
  return {
    provider: 'openwaters',
    rows,
    status: rows.length ? 'live' : 'empty',
    source: 'OpenWaters',
    coverage: OPEN_WATERS_COVERAGE,
    boxes,
    newestPositionAt: rows[0]?.last_position_UTC || null,
    rejectedCount,
    rawRowCount: payload.features.length,
    truncated: records.size > cap,
  };
}
