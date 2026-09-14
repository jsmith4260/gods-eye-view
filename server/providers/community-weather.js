import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  weatherPoint,
  normalizeForecast,
  normalizeNwsAlerts,
  parseSpcReports,
  completedSpcDay,
  boundedWeatherText,
} from '../../src/data/communityWeatherModel.js';

const USER_AGENT =
  'GodsEyeView/0.1 (https://github.com/bilawalsidhu/gods-eye-view)';
const MAX_CACHE = 64;

function runtime({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  const cache = new Map(),
    pending = new Map();
  const allow = makeRateLimiter({ windowMs: 60000, max: 60, globalMax: 240 });
  async function upstream(url, maxBytes, json = true) {
    const signal = AbortSignal.timeout(12000);
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal,
      headers: {
        Accept: json
          ? 'application/geo+json, application/json;q=0.9'
          : 'text/csv',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Provider unavailable');
    }
    const text = await readResponseTextCapped(response, maxBytes, signal);
    return json ? JSON.parse(text) : text;
  }
  async function cached(key, ttl, staleMs, load) {
    const entry = cache.get(key),
      age = entry ? now() - entry.fetchedAt : Infinity;
    if (age >= 0 && age < ttl) return { ...entry, status: 'cached' };
    if (!pending.has(key) && pending.size >= 12) throw new Error('Busy');
    return coalesceProxyRequest(pending, key, async () => {
      try {
        const value = await load();
        const fresh = { value, fetchedAt: now(), status: 'ready' };
        cache.delete(key);
        cache.set(key, fresh);
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
        return fresh;
      } catch (error) {
        if (entry && age >= 0 && age < staleMs)
          return { ...entry, status: 'stale' };
        throw error;
      }
    }).promise;
  }
  function route(handler) {
    return async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'Method Not Allowed' });
      if (!allow(clientKey(req)))
        return send(429, { error: 'Too many requests; retry shortly' });
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/') return send(404, { error: 'Not found' });
      try {
        return await handler(url.searchParams, send);
      } catch {
        return send(503, { error: 'Weather provider temporarily unavailable' });
      }
    };
  }
  return { upstream, cached, route, now };
}

function validParams(params, keys) {
  return [...params.keys()].every(
    (key) => keys.includes(key) && params.getAll(key).length === 1,
  );
}
function pointParams(params) {
  return weatherPoint({
    latitude: params.get('latitude'),
    longitude: params.get('longitude'),
  });
}
function keyOf(point) {
  return `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`;
}
function plugin(name, handlers) {
  const install = (server) => {
    for (const [path, handler] of handlers)
      server.middlewares.use(path, handler);
  };
  return { name, configureServer: install, configurePreviewServer: install };
}

export function weatherForecastProxy(options) {
  const api = runtime(options);
  return plugin('community-weather-proxy', [
    [
      '/api/weather/forecast',
      api.route(async (params, send) => {
        const point = pointParams(params);
        if (!point || !validParams(params, ['latitude', 'longitude']))
          return send(400, { error: 'Valid coordinates required' });
        const result = await api.cached(
          `forecast:${keyOf(point)}`,
          5 * 60000,
          30 * 60000,
          async () => {
            const query = new URLSearchParams({
              latitude: point.latitude.toFixed(3),
              longitude: point.longitude.toFixed(3),
              current:
                'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
              daily:
                'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
              forecast_days: '7',
              timezone: 'auto',
              temperature_unit: 'celsius',
            });
            const value = normalizeForecast(
              await api.upstream(
                `https://api.open-meteo.com/v1/forecast?${query}`,
                256 * 1024,
              ),
            );
            if (!value) throw new Error('Malformed forecast');
            return value;
          },
        );
        return send(200, {
          ...result.value,
          fetchedAt: result.fetchedAt,
          status: result.status,
          coordinates: point,
        });
      }),
    ],
    [
      '/api/weather/search',
      api.route(async (params, send) => {
        const name = (params.get('name') || '').trim();
        if (
          !validParams(params, ['name']) ||
          name.length < 2 ||
          name.length > 80
        )
          return send(400, { error: 'Search requires 2–80 characters' });
        const result = await api.cached(
          `search:${name.toLowerCase()}`,
          60 * 60000,
          0,
          async () => {
            const query = new URLSearchParams({
              name,
              count: '5',
              language: 'en',
              format: 'json',
            });
            const data = await api.upstream(
              `https://geocoding-api.open-meteo.com/v1/search?${query}`,
              128 * 1024,
            );
            return (Array.isArray(data?.results) ? data.results : [])
              .slice(0, 5)
              .flatMap((row) => {
                const point = weatherPoint(row);
                if (!point) return [];
                return [
                  {
                    ...point,
                    name: boundedWeatherText(row.name, 120),
                    label: boundedWeatherText(
                      [row.name, row.admin1, row.country]
                        .filter(Boolean)
                        .join(', '),
                      260,
                    ),
                  },
                ];
              });
          },
        );
        return send(200, { results: result.value });
      }),
    ],
  ]);
}

export function noaaHazardsProxy(options) {
  const api = runtime(options);
  return plugin('noaa-hazards-proxy', [
    [
      '/api/noaa/hazards',
      api.route(async (params, send) => {
        const point = params.size ? pointParams(params) : null;
        if (
          !validParams(params, ['latitude', 'longitude']) ||
          (params.size && !point)
        )
          return send(400, { error: 'Valid coordinates required' });
        const reportDay = completedSpcDay(api.now());
        const [nws, spc] = await Promise.allSettled([
          api.cached(
            `nws:${point ? keyOf(point) : 'all'}`,
            60000,
            5 * 60000,
            async () => {
              const query = new URLSearchParams({
                active: 'true',
                status: 'actual',
                limit: '500',
              });
              if (point)
                query.set(
                  'point',
                  `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`,
                );
              const data = await api.upstream(
                `https://api.weather.gov/alerts?${query}`,
                4 * 1024 * 1024,
              );
              const alerts = normalizeNwsAlerts(data, api.now());
              if (!alerts) throw new Error('Malformed alerts');
              return {
                alerts,
                limited:
                  Boolean(data.pagination?.next) || data.features.length >= 500,
              };
            },
          ),
          api.cached(
            `spc:${reportDay}`,
            15 * 60000,
            6 * 60 * 60000,
            async () => {
              const compact = reportDay.slice(2).replaceAll('-', '');
              const text = await api.upstream(
                `https://www.spc.noaa.gov/climo/reports/${compact}_rpts.csv`,
                2 * 1024 * 1024,
                false,
              );
              const reports = parseSpcReports(text, reportDay);
              if (!reports) throw new Error('Malformed reports');
              return reports;
            },
          ),
        ]);
        if (nws.status === 'rejected' && spc.status === 'rejected')
          return send(503, { error: 'NWS alerts and SPC reports unavailable' });
        const metadata = (result) =>
          result.status === 'fulfilled'
            ? { status: result.value.status, fetchedAt: result.value.fetchedAt }
            : { status: 'unavailable', fetchedAt: null };
        const alerts =
          nws.status === 'fulfilled'
            ? nws.value.value.alerts.filter(
                (row) => Date.parse(row.expires) > api.now(),
              )
            : [];
        return send(200, {
          alerts,
          reports: spc.status === 'fulfilled' ? spc.value.value : [],
          reportDay,
          limited: nws.status === 'fulfilled' && nws.value.value.limited,
          sources: { nws: metadata(nws), spc: metadata(spc) },
          fetchedAt: api.now(),
          coordinates: point,
          unmappedAlerts: alerts.filter((row) => !row.geometry).length,
        });
      }),
    ],
  ]);
}
