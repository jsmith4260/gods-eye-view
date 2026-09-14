// Adapted from gietabhi10's MIT-licensed saved locations PR #358.
import {
  LAYER_STATE_REGISTRY,
  normalizeLayerState,
} from './data/layerState.js';

export const SAVED_LOCATIONS_STORAGE_KEY = 'godsEyeView.savedLocations.v1';
export const MAX_SAVED_LOCATIONS = 24;
const MAX_STORAGE_CHARS = 200_000;
const MAP_IDS = new Set([
  'photoreal',
  'bing-aerial',
  'bing-labels',
  'esri-imagery',
  'osm',
]);
const inRange = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;

function savedLayerState(value) {
  const state = normalizeLayerState(value);
  // A bookmark is a place, not a deferred command to track a moving contact.
  state.options.flights.selectedFlightsTrackingId = null;
  state.options.flights.selectedMilitaryTrackingId = null;
  state.options.satellites.selectedSatTrackingId = null;
  return state;
}

export function normalizeSavedLocation(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string')
    return null;
  const name = value.name.trim().slice(0, 80);
  const c = value.camera;
  if (
    !name ||
    !c ||
    !inRange(c.lat, -90, 90) ||
    !inRange(c.lon, -180, 180) ||
    !inRange(c.alt, 0, 1e9)
  )
    return null;
  const heading = c.heading ?? 0,
    pitch = c.pitch ?? -35,
    roll = c.roll ?? 0;
  if (
    !inRange(heading, -360, 360) ||
    !inRange(pitch, -90, 90) ||
    !inRange(roll, -360, 360)
  )
    return null;
  return {
    id:
      typeof value.id === 'string' && value.id.length && value.id.length <= 100
        ? value.id
        : globalThis.crypto.randomUUID(),
    name,
    camera: {
      lat: c.lat,
      lon: c.lon,
      alt: Math.max(1, c.alt),
      heading,
      pitch,
      roll,
    },
    mapStack: MAP_IDS.has(value.mapStack) ? value.mapStack : null,
    createdAt: inRange(value.createdAt, 0, 1e15) ? value.createdAt : Date.now(),
    layerState: value.layerState ? savedLayerState(value.layerState) : null,
  };
}

function validLocations(values) {
  const result = [],
    ids = new Set();
  for (const value of Array.isArray(values) ? values.slice(0, 1000) : []) {
    const row = normalizeSavedLocation(value);
    if (!row || ids.has(row.id)) continue;
    result.push(row);
    ids.add(row.id);
    if (result.length === MAX_SAVED_LOCATIONS) break;
  }
  return result;
}

export function loadSavedLocations(storage) {
  try {
    const raw = (
      storage === undefined ? globalThis.localStorage : storage
    )?.getItem(SAVED_LOCATIONS_STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length > MAX_STORAGE_CHARS) return [];
    return validLocations(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function persistSavedLocations(locations, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (typeof target?.setItem !== 'function') return false;
    target.setItem(
      SAVED_LOCATIONS_STORAGE_KEY,
      JSON.stringify(validLocations(locations)),
    );
    return true;
  } catch {
    return false;
  }
}

export function upsertSavedLocation(locations, location) {
  const next = normalizeSavedLocation(location);
  return next
    ? validLocations([
        next,
        ...(Array.isArray(locations) ? locations : []).filter(
          (row) => row?.id !== next.id,
        ),
      ])
    : validLocations(locations);
}

export function removeSavedLocation(locations, id) {
  return validLocations(locations).filter((row) => row.id !== id);
}

export function captureSavedLayers(manager) {
  return savedLayerState({
    enabledLayerIds: [...manager.getEnabledLayerIds()],
    options: Object.fromEntries(
      LAYER_STATE_REGISTRY.filter((row) => row.optionOwner).map((row) => [
        row.optionOwner,
        manager.getLayerParams(row.optionOwner),
      ]),
    ),
  });
}

/** Reserve all explicit intents synchronously so subsequent user actions win. */
export async function restoreSavedLayers(manager, value, { signal } = {}) {
  const state = savedLayerState(value);
  const enabled = new Set(state.enabledLayerIds);
  return Promise.all(
    manager.getAll().map(async ({ id }) => {
      if (signal?.aborted) return { id, succeeded: false };
      try {
        const row = LAYER_STATE_REGISTRY.find((entry) => entry.id === id);
        const options = row?.optionOwner
          ? state.options[row.optionOwner]
          : null;
        const result = await manager.restoreLayerState(
          id,
          { enabled: enabled.has(id), params: options },
          { origin: 'user', signal },
        );
        return { id, succeeded: result.succeeded && !signal?.aborted };
      } catch {
        return { id, succeeded: false };
      }
    }),
  );
}
