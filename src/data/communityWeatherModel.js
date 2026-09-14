/** Pure, bounded normalization shared by the weather UI and local providers. */
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
export const boundedWeatherText = (value, max = 1000) =>
  typeof value === 'string' ? value.slice(0, max).trim() : '';

export function weatherPoint(value) {
  const latitude = value?.latitude ?? value?.lat;
  const longitude = value?.longitude ?? value?.lon;
  if (
    latitude === null ||
    longitude === null ||
    latitude === undefined ||
    longitude === undefined ||
    String(latitude).trim() === '' ||
    String(longitude).trim() === ''
  )
    return null;
  const lat = Number(latitude),
    lon = Number(longitude);
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
    ? { latitude: lat, longitude: lon }
    : null;
}

export function formatTemperature(value, unit = 'c') {
  return finite(value) === null
    ? '—'
    : `${Math.round(unit === 'f' ? (value * 9) / 5 + 32 : value)}°${unit === 'f' ? 'F' : 'C'}`;
}

export function weatherCondition(code) {
  if (code === 0) return 'Clear';
  if ([1, 2].includes(code)) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Conditions unavailable';
}

export function normalizeForecast(payload) {
  if (
    !payload?.current ||
    !Array.isArray(payload?.daily?.time) ||
    !payload.daily.time.length
  )
    return null;
  const current = payload.current,
    daily = payload.daily;
  const days = daily.time.slice(0, 7).flatMap((date, index) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? [
          {
            date,
            max: finite(daily.temperature_2m_max?.[index]),
            min: finite(daily.temperature_2m_min?.[index]),
            code: finite(daily.weather_code?.[index]),
            precipitationProbability: finite(
              daily.precipitation_probability_max?.[index],
            ),
          },
        ]
      : [],
  );
  if (!days.length) return null;
  return {
    timezone: boundedWeatherText(payload.timezone, 80) || 'UTC',
    current: {
      time: boundedWeatherText(current.time, 40),
      temperature: finite(current.temperature_2m),
      apparent: finite(current.apparent_temperature),
      humidity: finite(current.relative_humidity_2m),
      precipitation: finite(current.precipitation),
      wind: finite(current.wind_speed_10m),
      code: finite(current.weather_code),
    },
    days,
  };
}

function alertGeometry(geometry) {
  const pair = (value) =>
    Array.isArray(value) &&
    value.length >= 2 &&
    finite(value[0]) !== null &&
    finite(value[1]) !== null &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90;
  if (geometry?.type === 'Point' && pair(geometry.coordinates))
    return { type: 'Point', coordinates: geometry.coordinates.slice(0, 2) };
  if (!['Polygon', 'MultiPolygon'].includes(geometry?.type)) return null;
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || polygons.length > 32) return null;
  let count = 0;
  const copied = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length || polygon.length > 32)
      return null;
    const rings = [];
    for (const ring of polygon) {
      if (
        !Array.isArray(ring) ||
        ring.length < 4 ||
        (count += ring.length) > 10000 ||
        !ring.every(pair)
      )
        return null;
      rings.push(ring.map((p) => p.slice(0, 2)));
    }
    copied.push(rings);
  }
  return {
    type: geometry.type,
    coordinates: geometry.type === 'Polygon' ? copied[0] : copied,
  };
}

export function normalizeNwsAlerts(payload, now = Date.now()) {
  if (!Array.isArray(payload?.features)) return null;
  const result = [],
    ids = new Set();
  for (const feature of payload.features.slice(0, 1000)) {
    const p = feature?.properties,
      id = boundedWeatherText(feature?.id || p?.id, 300);
    if (
      !p ||
      !id ||
      ids.has(id) ||
      p.status !== 'Actual' ||
      p.messageType === 'Cancel'
    )
      continue;
    const expires = Date.parse(p.expires),
      effective = Date.parse(p.effective);
    if (
      !Number.isFinite(expires) ||
      expires <= now ||
      (Number.isFinite(effective) && effective > now)
    )
      continue;
    const event = boundedWeatherText(p.event, 120);
    if (!event) continue;
    ids.add(id);
    result.push({
      id,
      event,
      title: boundedWeatherText(p.headline, 600) || event,
      area: boundedWeatherText(p.areaDesc, 1800),
      description: boundedWeatherText(p.description, 12000),
      instruction: boundedWeatherText(p.instruction, 6000),
      severity: boundedWeatherText(p.severity, 30),
      sent: boundedWeatherText(p.sent, 50),
      effective: boundedWeatherText(p.effective, 50),
      expires: p.expires,
      geometry: alertGeometry(feature.geometry),
    });
  }
  return result;
}

/** Last fully completed SPC convective day, which runs from 12Z to 12Z. */
export function completedSpcDay(now = Date.now()) {
  const day = new Date(now);
  day.setUTCDate(day.getUTCDate() - (day.getUTCHours() < 12 ? 2 : 1));
  return day.toISOString().slice(0, 10);
}

function csvFields(line) {
  const fields = [];
  let field = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else field += c;
  }
  fields.push(field.trim());
  return fields;
}

export function parseSpcReports(csv, reportDay) {
  if (
    typeof csv !== 'string' ||
    csv.length > 2 * 1024 * 1024 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(reportDay)
  )
    return null;
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (
    !lines.some((line) =>
      line.startsWith('Time,F_Scale,Location,County,State,Lat,Lon,Comments'),
    )
  )
    return null;
  let kind = null;
  const rows = [];
  for (const line of lines) {
    const fields = csvFields(line);
    if (fields[0] === 'Time') {
      kind =
        { F_Scale: 'tornado', Speed: 'wind', Size: 'hail' }[fields[1]] || null;
      continue;
    }
    if (!kind || fields.length < 8 || !/^\d{4}$/.test(fields[0])) continue;
    const point = weatherPoint({ latitude: fields[5], longitude: fields[6] });
    const hour = Number(fields[0].slice(0, 2)),
      minute = Number(fields[0].slice(2));
    if (!point || hour > 23 || minute > 59) continue;
    const date = new Date(`${reportDay}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return null;
    if (hour < 12) date.setUTCDate(date.getUTCDate() + 1);
    date.setUTCHours(hour, minute);
    rows.push({
      id: `spc:${reportDay}:${kind}:${rows.length}`,
      kind,
      ...point,
      time: date.toISOString(),
      place: boundedWeatherText(
        [fields[2], fields[4]].filter(Boolean).join(', '),
        200,
      ),
      description: boundedWeatherText(fields.slice(7).join(', '), 2000),
      magnitude: boundedWeatherText(fields[1], 30),
      preliminary: true,
    });
    if (rows.length >= 1000) break;
  }
  return rows;
}
