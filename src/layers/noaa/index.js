import * as Cesium from 'cesium';
import { weatherPoint } from '../../data/communityWeatherModel.js';

const escapeHtml = (value) =>
  String(value || '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const severityColor = (row) =>
  row.severity === 'Extreme' ||
  /Tornado Warning|Tsunami Warning/.test(row.event)
    ? Cesium.Color.RED
    : row.severity === 'Severe'
      ? Cesium.Color.ORANGE
      : Cesium.Color.YELLOW;

/** NWS supplied boundaries plus dated SPC markers; unlocated alerts stay in the panel. */
export function createNoaaHazardsLayer({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  let viewer = null,
    dataSource = null,
    request = null,
    enabled = false;
  let stats = {
    count: 0,
    lastUpdate: null,
    error: null,
    stale: false,
    loading: false,
    unmappedAlerts: 0,
    sources: null,
    reportDay: null,
  };
  let lastAlerts = [],
    lastReports = [];
  const alertExpirations = new Map();
  function pruneExpiredAlerts() {
    for (const [id, expires] of alertExpirations)
      if (expires <= now()) {
        dataSource?.entities.removeById(id);
        alertExpirations.delete(id);
      }
    lastAlerts = lastAlerts.filter((row) => Date.parse(row.expires) > now());
    stats.count = lastAlerts.length + lastReports.length;
    stats.renderedCount = dataSource?.entities.values.length || 0;
    stats.unmappedAlerts = lastAlerts.filter((row) => !row.geometry).length;
  }
  const layer = {
    id: 'noaa-hazards',
    name: 'NOAA Alerts & Storm Reports',
    icon: '⚠',
    source: 'NOAA NWS / SPC',
    updateInterval: 60000,
    async init(value, { signal } = {}) {
      if (viewer) throw new Error('NOAA layer is already initialized');
      viewer = value;
      const owned = new Cesium.CustomDataSource('noaa-hazards');
      dataSource = owned;
      owned.show = false;
      try {
        await value.dataSources.add(owned);
        if (dataSource !== owned || viewer !== value || signal?.aborted) {
          value.dataSources.remove(owned, true);
          if (dataSource === owned) {
            dataSource = null;
            viewer = null;
          }
          return false;
        }
        return true;
      } catch (error) {
        value.dataSources.remove(owned, true);
        if (dataSource === owned) {
          dataSource = null;
          viewer = null;
        }
        throw error;
      }
    },
    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      viewer?.scene?.requestRender?.();
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      stats.loading = false;
      if (dataSource) dataSource.show = false;
      viewer?.scene?.requestRender?.();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const owned = new AbortController();
      request = owned;
      const signals = [owned.signal, AbortSignal.timeout(18000)];
      if (signal) signals.push(signal);
      const combinedSignal = AbortSignal.any(signals);
      stats.loading = true;
      pruneExpiredAlerts();
      try {
        combinedSignal.throwIfAborted();
        const response = await fetchImpl('/api/noaa/hazards', {
          signal: combinedSignal,
        });
        if (!response.ok) throw new Error('NOAA providers unavailable');
        const payload = await response.json();
        if (!Array.isArray(payload.alerts) || !Array.isArray(payload.reports))
          throw new Error('Malformed NOAA response');
        if (
          !enabled ||
          request !== owned ||
          combinedSignal.aborted ||
          !dataSource
        )
          return false;
        const entities = [];
        const expirations = new Map();
        for (const row of payload.alerts.slice(0, 500)) {
          if (!row.geometry || Date.parse(row.expires) <= now()) continue;
          const color = severityColor(row);
          const properties = {
            event: row.event,
            area: row.area,
            expires: row.expires,
            source: 'NOAA NWS',
          };
          const description = `<p>${escapeHtml(row.title)}</p><p>${escapeHtml(row.area)}</p><p>Expires ${escapeHtml(row.expires)}</p><p>${escapeHtml(row.description)}</p>`;
          if (row.geometry.type === 'Point') {
            const [lon, lat] = row.geometry.coordinates || [];
            if (!weatherPoint({ lat, lon })) continue;
            entities.push({
              id: `noaa:${row.id}`,
              name: row.event,
              description,
              properties,
              position: Cesium.Cartesian3.fromDegrees(lon, lat),
              point: {
                pixelSize: 9,
                color,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
            });
            expirations.set(`noaa:${row.id}`, Date.parse(row.expires));
          } else if (['Polygon', 'MultiPolygon'].includes(row.geometry.type)) {
            const polygons =
              row.geometry.type === 'Polygon'
                ? [row.geometry.coordinates]
                : row.geometry.coordinates;
            for (const [index, rings] of polygons.slice(0, 32).entries()) {
              if (entities.length >= 800) break;
              if (!Array.isArray(rings) || !rings[0]?.length) continue;
              const toPositions = (ring) =>
                Cesium.Cartesian3.fromDegreesArray(
                  ring.flatMap((point) => point.slice(0, 2)),
                );
              entities.push({
                id: `noaa:${row.id}:${index}`,
                name: row.event,
                description,
                properties,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    toPositions(rings[0]),
                    rings
                      .slice(1)
                      .map(
                        (ring) =>
                          new Cesium.PolygonHierarchy(toPositions(ring)),
                      ),
                  ),
                  material: color.withAlpha(0.18),
                  outline: true,
                  outlineColor: color.withAlpha(0.8),
                },
              });
              expirations.set(
                `noaa:${row.id}:${index}`,
                Date.parse(row.expires),
              );
            }
          }
        }
        for (const row of payload.reports.slice(0, 500)) {
          const point = weatherPoint(row);
          if (!point) continue;
          const title = `Preliminary ${row.kind} report · ${payload.reportDay}`;
          entities.push({
            id: row.id,
            name: title,
            position: Cesium.Cartesian3.fromDegrees(
              point.longitude,
              point.latitude,
            ),
            description: `<p>${escapeHtml(title)}</p><p>${escapeHtml(row.place)} · ${escapeHtml(row.time)}</p><p>${escapeHtml(row.description)}</p>`,
            properties: {
              kind: row.kind,
              place: row.place,
              time: row.time,
              source: 'NOAA SPC',
              preliminary: true,
            },
            point: {
              pixelSize: 6,
              color:
                row.kind === 'tornado'
                  ? Cesium.Color.MAGENTA
                  : row.kind === 'hail'
                    ? Cesium.Color.CYAN
                    : Cesium.Color.CORNFLOWERBLUE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
        }
        dataSource.entities.suspendEvents();
        try {
          dataSource.entities.removeAll();
          for (const entity of entities) dataSource.entities.add(entity);
        } finally {
          dataSource.entities.resumeEvents();
        }
        alertExpirations.clear();
        for (const [id, expires] of expirations)
          alertExpirations.set(id, expires);
        lastAlerts = payload.alerts;
        lastReports = payload.reports;
        const sources = Object.values(payload.sources || {});
        stats = {
          count: payload.alerts.length + payload.reports.length,
          renderedCount: entities.length,
          lastUpdate:
            Math.max(
              0,
              ...sources.map((value) => Number(value.fetchedAt) || 0),
            ) || null,
          error: sources.some((value) => value.status === 'unavailable')
            ? 'Some NOAA providers unavailable'
            : null,
          stale: sources.some((value) => value.status === 'stale'),
          loading: false,
          unmappedAlerts: payload.unmappedAlerts || 0,
          sources: payload.sources,
          reportDay: payload.reportDay,
          limited:
            payload.limited ||
            payload.reports.length > 500 ||
            entities.length >= 800,
        };
        viewer?.scene?.requestRender?.();
        return true;
      } catch (error) {
        if (
          request === owned &&
          enabled &&
          !owned.signal.aborted &&
          !signal?.aborted
        ) {
          pruneExpiredAlerts();
          stats = {
            ...stats,
            error: error.message,
            stale: stats.lastUpdate !== null,
          };
          viewer?.scene?.requestRender?.();
        }
        return false;
      } finally {
        if (request === owned) {
          request = null;
          stats.loading = false;
        }
      }
    },
    getStats() {
      const feedHealth = [
        ['nws', 'nws-alerts', 'NWS active alerts', lastAlerts.length],
        [
          'spc',
          'spc-reports',
          'SPC preliminary storm reports',
          lastReports.length,
        ],
      ].map(([key, id, label, count]) => {
        const source = stats.sources?.[key];
        return {
          id,
          label,
          name: label,
          source: key === 'nws' ? 'NOAA NWS' : 'NOAA SPC',
          count,
          enabled,
          loading: stats.loading,
          lastUpdate: source?.fetchedAt || null,
          stale:
            source?.status === 'stale' || (stats.stale && Boolean(stats.error)),
          error:
            source?.status === 'unavailable'
              ? `${label} unavailable`
              : stats.error && !stats.sources
                ? stats.error
                : null,
          status: source?.status || 'idle',
        };
      });
      return { ...stats, enabled, feedHealth };
    },
    destroy() {
      layer.disable();
      if (dataSource) viewer?.dataSources?.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      alertExpirations.clear();
      lastAlerts = [];
      lastReports = [];
      stats = {
        count: 0,
        lastUpdate: null,
        error: null,
        stale: false,
        loading: false,
        unmappedAlerts: 0,
      };
    },
  };
  return layer;
}
