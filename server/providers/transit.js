/** Bounded keyless GTFS-RT proxy adapted from PR218 at 481e4f09e695. */
import { coalesceProxyRequest } from './common/http.js';
import {
  getTransitFeed,
  publicTransitCatalog,
} from '../../src/data/transitFeeds.js';
import { decodeVehiclePositions } from '../../src/data/gtfsRealtime.js';

export const TRANSIT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const TRANSIT_TIMEOUT_MS = 15_000;
const TTL_MS = 15_000;
const MAX_AGE_MS = 600_000;
const MAX_VEHICLES = 15_000;

/** Validate every redirect before contacting its destination. */
export function isTransitRedirectAllowed(value, feed) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      return false;
    if (url.href === feed.url) return true;
    return (
      feed.id === 'capmetro-austin' &&
      url.hostname === 'data.texas.gov' &&
      /^\/api\/views\/eiei-9rpf\/files\/[a-f0-9-]{36}$/.test(url.pathname) &&
      url.search === '?filename=vehiclepositions.pb'
    );
  } catch {
    return false;
  }
}

/** Read bytes with a streaming cap and abort listener through the entire body. */
export async function readTransitBytes(response, maxBytes, signal) {
  const tooLarge = () => new Error('Transit response too large');
  signal.throwIfAborted();
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Transit response has no body');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function resolveRoute(value) {
  if (value === '/feeds' || value === '/feeds/') return { catalog: true };
  const match = /^\/vehicles\/([a-z0-9][a-z0-9-]{1,63})\/?$/.exec(value || '');
  const feed = match ? getTransitFeed(match[1]) : null;
  return feed ? { feed } : null;
}

/** Injectable fetch and clock keep the transport tests offline. Cache stays in memory. */
export function createTransitMiddleware({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  timeoutMs = TRANSIT_TIMEOUT_MS,
} = {}) {
  const cache = new Map(),
    inFlight = new Map(),
    failedAt = new Map();
  const send = (res, status, body, cacheState = 'NONE') => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-GEV-Cache': cacheState,
      ...(status === 405 ? { Allow: 'GET' } : {}),
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  async function refresh(feed) {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Transit request timed out', 'TimeoutError'),
        ),
      timeoutMs,
    );
    timer.unref?.();
    try {
      let url = feed.url,
        upstream;
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (!isTransitRedirectAllowed(url, feed))
          throw new Error('Unregistered transit redirect');
        upstream = await fetchImpl(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent':
              'gods-eye-view-transit-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
            Accept: 'application/x-protobuf, application/octet-stream',
            'Accept-Encoding': 'gzip',
            ...(feed.headers || {}),
          },
        });
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(upstream.status)) {
          const location = upstream.headers.get('location');
          void upstream.body?.cancel().catch(() => {});
          if (!location || redirects === 3)
            throw new Error('Invalid transit redirect');
          url = new URL(location, url).href;
          continue;
        }
        break;
      }
      if (!upstream.ok) {
        void upstream.body?.cancel().catch(() => {});
        throw new Error('Transit upstream unavailable');
      }
      const decoded = decodeVehiclePositions(
        await readTransitBytes(
          upstream,
          TRANSIT_MAX_BODY_BYTES,
          controller.signal,
        ),
      );
      const fetchedAt = now();
      if (!decoded.version) throw new Error('Invalid GTFS-RT header');
      const vehicles = decoded.vehicles
        .filter((record) => {
          const timestamp = record.timestamp ?? decoded.timestamp;
          if (
            !Number.isFinite(timestamp) ||
            timestamp <= 0 ||
            timestamp > fetchedAt / 1000 + 300 ||
            fetchedAt / 1000 - timestamp > 600
          )
            return false;
          record.timestamp = timestamp;
          return true;
        })
        .slice(0, MAX_VEHICLES);
      const stale =
        !Number.isFinite(decoded.timestamp) ||
        decoded.timestamp > fetchedAt / 1000 + 300 ||
        fetchedAt / 1000 - decoded.timestamp > 600;
      const body = JSON.stringify({
        feedId: feed.id,
        name: feed.name,
        fetchedAt,
        feedTimestamp: decoded.timestamp,
        stale,
        version: decoded.version,
        entityCount: decoded.entityCount,
        count: vehicles.length,
        vehicles,
      });
      const entry = { at: fetchedAt, body };
      cache.set(feed.id, entry);
      failedAt.delete(feed.id);
      return entry;
    } finally {
      clearTimeout(timer);
    }
  }
  return async (req, res) => {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const route = resolveRoute(req.url);
    if (!route) {
      send(res, 404, { error: 'Unknown transit feed' });
      return;
    }
    if (route.catalog) {
      send(res, 200, { feeds: publicTransitCatalog() });
      return;
    }
    const { feed } = route,
      cached = cache.get(feed.id);
    const age = cached ? now() - cached.at : Infinity;
    const ttl = Math.max(TTL_MS, feed.minPollMs || 0);
    if (cached && age >= 0 && age < ttl) {
      send(res, 200, cached.body, 'HIT');
      return;
    }
    const failure = failedAt.get(feed.id);
    if (failure !== undefined && now() - failure < ttl) {
      if (cached && age >= 0 && age < MAX_AGE_MS)
        send(res, 200, cached.body, 'STALE-ERROR');
      else
        send(res, 502, { error: 'Transit feed unavailable', feedId: feed.id });
      return;
    }
    const request = coalesceProxyRequest(inFlight, feed.id, () =>
      refresh(feed),
    );
    try {
      const fresh = await request.promise;
      send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
    } catch {
      failedAt.set(feed.id, now());
      const latestAge = cached ? now() - cached.at : Infinity;
      if (cached && latestAge >= 0 && latestAge < MAX_AGE_MS)
        send(res, 200, cached.body, 'STALE-ERROR');
      else {
        cache.delete(feed.id);
        send(res, 502, { error: 'Transit feed unavailable', feedId: feed.id });
      }
    }
  };
}

export function transitProxy(options) {
  const middleware = createTransitMiddleware(options);
  const install = (server) => {
    server.middlewares.use('/api/transit', middleware);
  };
  return {
    name: 'transit-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
