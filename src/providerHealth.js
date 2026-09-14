// Adapted from gietabhi10's MIT-licensed provider health PR #366.
import { layerFeedState } from './ui/layerPanel.js';
import { GUIDANCE_STATUSES } from './loadingFeedback.js';

const LABELS = {
  nominal: 'LIVE',
  loading: 'LOADING',
  stale: 'STALE',
  degraded: 'DEGRADED',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
  off: 'OFF',
  waiting: 'WAITING',
  ready: 'READY',
  key: 'KEY REQUIRED',
};

function age(value, now) {
  if (!Number.isFinite(value) || value <= 0) return 'never';
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function buildRow(layer, now, parentId = null) {
  const stats = layer.stats || {};
  let state = layer.enabled ? layerFeedState(stats) : 'off';
  if (
    layer.lifecycleState === 'enabling' ||
    layer.lifecycleState === 'disabling'
  )
    state = 'loading';
  else if (layer.enabled && (stats.keyRequired || stats.missingKey))
    state = 'key';
  else if (layer.lifecycleUncertain) state = 'degraded';
  else if (
    state === 'nominal' &&
    GUIDANCE_STATUSES.includes(stats.status) &&
    !(stats.count > 0)
  )
    state = 'waiting';
  else if (
    state === 'nominal' &&
    !stats.lastUpdate &&
    !['live', 'ok', 'ready'].includes(stats.status)
  )
    state = stats.count > 0 ? 'ready' : 'waiting';
  const retryInSec = Number.isFinite(stats.retryAt)
    ? Math.max(0, Math.ceil((stats.retryAt - now) / 1000))
    : Number.isFinite(stats.retryInSec)
      ? Math.max(0, Math.ceil(stats.retryInSec))
      : null;
  const updated = age(stats.lastUpdate, now);
  return {
    id: parentId ? `${parentId}:${layer.id}` : String(layer.id),
    parentId,
    name: String(layer.name || layer.id),
    source: String(stats.source || layer.source || 'unknown'),
    state,
    label: LABELS[state] || 'WAITING',
    updated,
    detail: String(
      stats.error ||
        stats.lastError ||
        stats.managerRefreshError ||
        stats.loadingLabel ||
        stats.coverage ||
        updated,
    ),
    count:
      Number.isFinite(stats.count) && stats.count >= 0
        ? Math.floor(stats.count)
        : null,
    retryInSec,
  };
}

export function buildProviderHealthRows(layers, now = Date.now()) {
  const rows = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (!layer || layer.showInTogglePanel === false) continue;
    rows.push(buildRow(layer, now));
    for (const feed of Array.isArray(layer.stats?.feedHealth)
      ? layer.stats.feedHealth.slice(0, 50)
      : []) {
      if (!feed || !feed.id) continue;
      rows.push(
        buildRow(
          { ...feed, enabled: layer.enabled, stats: feed },
          now,
          layer.id,
        ),
      );
    }
  }
  return rows;
}
