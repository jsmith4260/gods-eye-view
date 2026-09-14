import { readResponseTextCapped } from '../common/http.js';
import {
  normalizeOpenWatersSnapshot,
  regionalVesselBoxes,
  OPEN_WATERS_MAX_ROWS,
  OPEN_WATERS_COVERAGE,
} from '../../../src/data/openWatersAis.js';

const UPSTREAM = 'https://ais.openwaters.io/v1/vessels';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 30_000;
const MAX_CACHE = 24;
const MAX_ACTIVE = 2;
const TIMEOUT_MS = 7000;

/** Read-only, fixed-origin regional proxy shared by development and preview. */
export function openWatersProxy({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  aisConfigured = () => Boolean(process.env.AISSTREAM_API_KEY),
} = {}) {
  const cache = new Map(),
    pending = new Map();
  let active = 0;
  async function snapshot(boxes, maxRows) {
    const key = JSON.stringify(boxes);
    let record = cache.get(key);
    if (!record || now() - record.at >= CACHE_MS) {
      if (!pending.has(key)) {
        if (active >= MAX_ACTIVE)
          throw Object.assign(new Error('Busy'), { status: 429 });
        active++;
        const task = (async () => {
          const signal = AbortSignal.timeout(TIMEOUT_MS);
          const features = [];
          for (const box of boxes) {
            const url = new URL(UPSTREAM);
            url.searchParams.set(
              'bbox',
              [box.south, box.west, box.north, box.east].join(','),
            );
            const response = await fetchImpl(url.toString(), {
              signal,
              redirect: 'error',
              headers: {
                Accept: 'application/geo+json, application/json',
                'User-Agent': 'gods-eye-view/1.0',
              },
            });
            if (!response.ok) {
              void response.body?.cancel().catch(() => {});
              throw new Error('Upstream unavailable');
            }
            const payload = JSON.parse(
              await readResponseTextCapped(response, MAX_BYTES, signal),
            );
            if (
              payload?.type !== 'FeatureCollection' ||
              !Array.isArray(payload.features)
            )
              throw new Error('Malformed collection');
            features.push(...payload.features);
          }
          // Retain only normalized, capped records, never the upstream envelope.
          const normalized = normalizeOpenWatersSnapshot(
            { type: 'FeatureCollection', features },
            { now: now(), boxes },
          );
          const next = { at: now(), value: normalized };
          cache.delete(key);
          cache.set(key, next);
          while (cache.size > MAX_CACHE)
            cache.delete(cache.keys().next().value);
          return next;
        })().finally(() => {
          active--;
          pending.delete(key);
        });
        pending.set(key, task);
      }
      record = await pending.get(key);
    }
    const rows = record.value.rows
      .filter((row) => row.expiresAtMs > now())
      .slice(0, maxRows);
    return {
      ...record.value,
      rows,
      newestPositionAt: rows[0]?.last_position_UTC || null,
      status: rows.length ? 'live' : 'empty',
      truncated: record.value.truncated || record.value.rows.length > maxRows,
    };
  }
  const install = ({ middlewares }) => {
    middlewares.use('/api/open-waters', async (req, res) => {
      const reply = (status, payload) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (status === 429) res.setHeader('Retry-After', '30');
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET') return reply(405, { error: 'GET required' });
      const query = new URL(req.url || '/', 'http://localhost');
      if (!['/', '/api/open-waters'].includes(query.pathname))
        return reply(404, { error: 'Unknown vessel route' });
      if (
        [...query.searchParams.keys()].some(
          (k) => !['lat', 'lon', 'maxRows', 'provider'].includes(k),
        )
      )
        return reply(400, { error: 'Unknown vessel query' });
      const provider = query.searchParams.get('provider') || 'auto';
      if (!['auto', 'openwaters'].includes(provider))
        return reply(400, { error: 'Unknown vessel provider' });
      if (provider === 'auto' && aisConfigured())
        return reply(200, { provider: 'aisstream' });
      const lat = query.searchParams.get('lat'),
        lon = query.searchParams.get('lon');
      let boxes;
      try {
        boxes = regionalVesselBoxes(
          lat?.trim() ? Number(lat) : NaN,
          lon?.trim() ? Number(lon) : NaN,
        );
      } catch {
        return reply(400, { error: 'Valid lat/lon are required' });
      }
      const requested = Number(
        query.searchParams.get('maxRows') || OPEN_WATERS_MAX_ROWS,
      );
      const maxRows = Number.isFinite(requested)
        ? Math.max(1, Math.min(OPEN_WATERS_MAX_ROWS, Math.floor(requested)))
        : OPEN_WATERS_MAX_ROWS;
      try {
        reply(200, await snapshot(boxes, maxRows));
      } catch (error) {
        reply(error.status === 429 ? 429 : 502, {
          provider: 'openwaters',
          rows: [],
          status: 'down',
          source: 'OpenWaters',
          coverage: OPEN_WATERS_COVERAGE,
          error: 'OpenWaters unavailable; no fresh regional positions',
        });
      }
    });
  };
  return {
    name: 'open-waters-vessels',
    configureServer: install,
    configurePreviewServer: install,
  };
}
