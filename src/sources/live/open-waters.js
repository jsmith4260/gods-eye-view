import { createAisStreamSource } from './standalone.js';
import { vesselSnapshot } from './vessels.js';
import { readResponse, httpError, LiveSourceError } from './contract.js';

/** Uses existing AISStream when configured, otherwise a regional keyless feed. */
export function createCommunityVesselSource({
  mode,
  aisApiUrl = '/api/ais-live',
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  aisSource,
} = {}) {
  const apiUrl =
    typeof aisApiUrl === 'string' && aisApiUrl.trim()
      ? aisApiUrl.trim()
      : '/api/ais-live';
  // Preserve existing custom AIS endpoints unless the user explicitly selects
  // a provider (including an explicit choice of automatic selection).
  const selectedMode =
    typeof mode === 'string' && mode.trim()
      ? mode.trim()
      : apiUrl !== '/api/ais-live'
        ? 'aisstream'
        : 'auto';
  const delegate = aisSource ?? createAisStreamSource({ fetchImpl, apiUrl });
  let active =
    selectedMode === 'aisstream'
      ? 'aisstream'
      : selectedMode === 'openwaters'
        ? 'openwaters'
        : null;
  return {
    get label() {
      return active === 'aisstream'
        ? delegate.label || 'AISStream'
        : active === 'openwaters'
          ? 'OpenWaters · regional AIS'
          : 'Live ships · automatic source';
    },
    async getSnapshot(query = {}, { signal } = {}) {
      if (selectedMode === 'aisstream')
        return delegate.getSnapshot(query, { signal });
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude)) params.set('lat', query.latitude);
      if (Number.isFinite(query.longitude)) params.set('lon', query.longitude);
      if (Number.isFinite(query.maxRows)) params.set('maxRows', query.maxRows);
      if (selectedMode === 'openwaters') params.set('provider', 'openwaters');
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/open-waters?' + params,
        { signal, cache: 'no-store' },
        'OpenWaters',
      );
      // The provider is known even when its request fails. Keep that attribution
      // available to the layer's error path before awaiting a delegated request.
      if (payload?.provider === 'openwaters') active = 'openwaters';
      if (!response.ok) throw httpError(response, 'OpenWaters');
      if (payload?.provider === 'aisstream') {
        active = 'aisstream';
        return delegate.getSnapshot(query, { signal });
      }
      if (payload?.provider !== 'openwaters' || !Array.isArray(payload.rows))
        throw new LiveSourceError('malformed', 'Malformed OpenWaters response');
      active = 'openwaters';
      const rows = payload.rows
        .filter(
          (row) => Number.isFinite(row?.expiresAtMs) && row.expiresAtMs > now(),
        )
        .slice(0, 2000);
      const snapshot = vesselSnapshot(
        {
          ...payload,
          rows,
          newestPositionAt: rows[0]?.last_position_UTC || null,
        },
        {
          source: 'OpenWaters · regional AIS',
          coverage:
            payload.coverage || 'Regional receiver coverage; incomplete',
        },
      );
      const details = new Map(rows.map((row) => [String(row.mmsi), row]));
      snapshot.records = snapshot.records.map((record) => {
        const row = details.get(record.id);
        return {
          ...record,
          callsign: row.callsign || '',
          navStatus: row.navStatus ?? null,
          provider: row.provider || 'OpenWaters',
          originSource: row.originSource || '',
          station: row.station || '',
          expiresAtMs: row.expiresAtMs,
        };
      });
      return {
        ...snapshot,
        status: response.status,
        emptyIsValid: true,
        complete: !payload.truncated,
        transportStatus: rows.length ? 'live' : 'empty',
        rawRowCount: payload.rawRowCount ?? rows.length,
        reason: !rows.length
          ? 'No fresh regional positions — receiver coverage is incomplete'
          : payload.truncated
            ? 'Regional vessel limit reached'
            : null,
      };
    },
    async getTrack(reference, { signal } = {}) {
      // OpenWaters history is not advertised: the layer accumulates observed fixes.
      return active === 'aisstream'
        ? delegate.getTrack(reference, { signal })
        : { records: [], complete: false };
    },
  };
}
