import * as Cesium from 'cesium';
import { buildProviderHealthRows } from '../providerHealth.js';
import {
  captureSavedLayers,
  loadSavedLocations,
  MAX_SAVED_LOCATIONS,
  normalizeSavedLocation,
  persistSavedLocations,
  removeSavedLocation,
  restoreSavedLayers,
  upsertSavedLocation,
} from '../savedLocations.js';
import { createSurfaceKeyboard } from './surfaceKeyboard.js';
import { createWeatherPanel } from './communityWeather.js';
import { observeCommunityMode } from './communityVisibility.js';

function element(documentRef, tag, text, className) {
  const node = documentRef.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  if (tag === 'button') node.type = 'button';
  return node;
}

/** Additional controls share the current viewer and data-manager lifecycle. */
export function createCommunityTools({
  viewer,
  styleManager,
  dataManager,
  mapStackController,
  documentRef = document,
}) {
  const el = (tag, text, cls) => element(documentRef, tag, text, cls);
  const root = el('div', null, 'community-tools');
  root.id = 'community-tools';
  const toggle = el('button', 'VIEWS & FEEDS', 'community-launcher');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'community-panel');
  const panel = el('section', null, 'community-panel');
  panel.id = 'community-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Views and feeds');
  const header = el('div', null, 'community-header');
  header.append(el('strong', 'VIEWS & FEEDS'));
  const close = el('button', 'Close');
  header.append(close);
  const tabs = el('div', null, 'community-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Views and feeds sections');
  const pages = {},
    buttons = {};
  for (const [key, title] of [
    ['saved', 'Saved views'],
    ['health', 'Feed health'],
    ['weather', 'Weather'],
  ]) {
    const button = el('button', title);
    button.id = `community-tab-${key}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `community-${key}`);
    const page = el('div', null, 'community-page');
    page.id = `community-${key}`;
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', button.id);
    pages[key] = page;
    buttons[key] = button;
    tabs.append(button);
  }
  panel.append(header, tabs, ...Object.values(pages));
  root.append(toggle, panel);
  documentRef.body.append(root);
  let active = 'saved',
    disposed = false,
    restoreController = null,
    timer = null,
    forecastStats = null;
  let saved = loadSavedLocations();
  const status = el('p', '', 'community-note');
  status.setAttribute('role', 'status');
  const hint = el(
    'p',
    'Save the current camera, map source, and layer settings on this browser.',
    'community-note',
  );
  const form = el('form', null, 'community-save-form');
  const input = el('input');
  input.maxLength = 80;
  input.required = true;
  input.placeholder = 'Name this view';
  input.setAttribute('aria-label', 'Saved view name');
  const saveButton = el('button', 'Save current view');
  saveButton.type = 'submit';
  const savedList = el('div', null, 'community-saved-list');
  form.append(input, saveButton);
  pages.saved.append(hint, form, status, savedList);
  const healthSummary = el('p', '', 'community-note');
  const healthList = el('div', null, 'community-health-list');
  pages.health.append(healthSummary, healthList);

  const getLocation = () => {
    // Prefer the actual center of the globe view over the camera's ground point.
    const canvas = viewer.scene.canvas;
    const ray = viewer.camera.getPickRay(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    const position = ray && viewer.scene.globe?.pick(ray, viewer.scene);
    const point = position
      ? Cesium.Cartographic.fromCartesian(position)
      : viewer.camera.positionCartographic;
    const lat = Cesium.Math.toDegrees(point.latitude),
      lon = Cesium.Math.toDegrees(point.longitude);
    return { lat, lon, label: `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
  };
  const weather = createWeatherPanel({
    container: pages.weather,
    getLocation,
    onFlyTo: ({ latitude, longitude }) =>
      styleManager.runImmediateLocationNavigation(() => {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            80_000,
          ),
          duration: 1,
        });
      }),
    onStatus: (stats) => {
      forecastStats = stats;
      renderHealth();
    },
  });
  const keyboard = createSurfaceKeyboard({
    root: panel,
    documentRef,
    isActive: () => !panel.hidden && root.getClientRects().length > 0,
    onEscape: () => setOpen(false),
    fallbackFocus: () => toggle,
  });

  function renderHealth() {
    if (disposed || panel.hidden || active !== 'health' || documentRef.hidden)
      return;
    const layers = dataManager.getAll();
    if (forecastStats)
      layers.push({
        id: 'forecast',
        name: 'Weather forecast',
        source: 'Open-Meteo',
        enabled: forecastStats.enabled === true,
        stats: forecastStats,
      });
    const rows = buildProviderHealthRows(layers);
    const roots = rows.filter((row) => !row.parentId);
    healthSummary.textContent = `${roots.filter((row) => row.state === 'nominal').length} live · ${roots.filter((row) => ['key', 'stale', 'degraded', 'unavailable'].includes(row.state)).length} need attention · ${roots.filter((row) => row.state === 'off').length} off`;
    healthList.replaceChildren(
      ...rows.map((row) => {
        const item = el(
          'div',
          null,
          `community-health-row${row.parentId ? ' community-health-child' : ''}`,
        );
        const title = el('div', null, 'community-row-title');
        const badge = el('span', row.label, 'community-badge');
        badge.dataset.state = row.state;
        title.append(el('strong', row.name), badge);
        item.append(
          title,
          el(
            'p',
            `${row.source} · ${row.count === null ? 'No count' : `${row.count.toLocaleString()} records`} · Updated ${row.updated}`,
            'community-note',
          ),
        );
        if (row.detail !== row.updated)
          item.append(el('p', row.detail.slice(0, 300), 'community-note'));
        if (row.retryInSec !== null && row.retryInSec > 0)
          item.append(el('p', `Retry in ${row.retryInSec}s`, 'community-note'));
        return item;
      }),
    );
  }

  function renderSaved() {
    savedList.replaceChildren();
    if (!saved.length)
      savedList.append(el('p', 'No saved views yet.', 'community-note'));
    for (const row of saved) {
      const item = el('div', null, 'community-saved-row');
      const restore = el('button', row.name, 'community-restore');
      restore.title = `${row.camera.lat.toFixed(3)}, ${row.camera.lon.toFixed(3)} · ${row.layerState?.enabledLayerIds.length ?? 0} layers`;
      restore.disabled = !!restoreController;
      restore.addEventListener('click', () => {
        void restoreView(row);
      });
      const remove = el('button', 'Delete');
      remove.setAttribute('aria-label', `Delete saved view ${row.name}`);
      remove.addEventListener('click', () => {
        const next = removeSavedLocation(saved, row.id);
        if (!persistSavedLocations(next)) {
          status.textContent =
            'Browser storage is unavailable. View was not deleted.';
          return;
        }
        saved = next;
        status.textContent = `Deleted ${row.name}.`;
        renderSaved();
      });
      item.append(restore, remove);
      savedList.append(item);
    }
  }

  async function restoreView(row) {
    if (disposed || restoreController) return;
    const token = styleManager.beginDeferredLocationNavigation();
    if (!Number.isInteger(token)) {
      status.textContent = 'Exit cockpit mode to restore a saved view.';
      return;
    }
    const controller = new AbortController();
    restoreController = controller;
    renderSaved();
    status.textContent = `Restoring ${row.name}…`;
    try {
      if (!styleManager.reassertDeferredLocationNavigation(token))
        throw new Error('Navigation was superseded.');
      const c = row.camera;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.alt),
        orientation: {
          heading: Cesium.Math.toRadians(c.heading),
          pitch: Cesium.Math.toRadians(c.pitch),
          roll: Cesium.Math.toRadians(c.roll),
        },
      });
      viewer.scene.requestRender();
      const mapAvailable =
        !row.mapStack || mapStackController.isStackAvailable(row.mapStack);
      if (row.mapStack && mapAvailable)
        styleManager.shareLinkManager?.claimRestoreLane?.('map');
      const mapRestore =
        row.mapStack && mapAvailable
          ? mapStackController.setStack(row.mapStack)
          : Promise.resolve(null);
      const [mapResult, layers] = await Promise.all([
        mapRestore,
        row.layerState
          ? restoreSavedLayers(dataManager, row.layerState, {
              signal: controller.signal,
            })
          : Promise.resolve([]),
      ]);
      if (disposed || controller.signal.aborted) return;
      const failed = layers.filter((result) => !result.succeeded).length;
      const mapIssue =
        row.mapStack &&
        (!mapAvailable ||
          mapResult?.activeId !== row.mapStack ||
          mapResult?.lastError);
      status.textContent = `Restored ${row.name}.${mapIssue ? ' Saved map source unavailable; current source retained.' : ''}${failed ? ` ${failed} layer changes could not complete; check Feed health.` : ''}`;
    } catch (error) {
      if (!disposed)
        status.textContent = `Could not fully restore view: ${error.message}`;
    } finally {
      restoreController = null;
      if (!disposed) renderSaved();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (saved.length >= MAX_SAVED_LOCATIONS) {
      status.textContent = '24 views saved. Delete a view to make room.';
      return;
    }
    if (
      dataManager
        .getAll()
        .some((row) => ['enabling', 'disabling'].includes(row.lifecycleState))
    ) {
      status.textContent = 'Wait for layer changes to finish before saving.';
      return;
    }
    const camera = viewer.camera,
      point = camera.positionCartographic;
    const row = normalizeSavedLocation({
      name: input.value,
      camera: {
        lat: Cesium.Math.toDegrees(point.latitude),
        lon: Cesium.Math.toDegrees(point.longitude),
        alt: point.height,
        heading: Cesium.Math.toDegrees(camera.heading),
        pitch: Cesium.Math.toDegrees(camera.pitch),
        roll: Cesium.Math.toDegrees(camera.roll),
      },
      mapStack: mapStackController.getActiveId(),
      layerState: captureSavedLayers(dataManager),
    });
    if (!row) {
      status.textContent = 'Enter a name and wait for a valid camera position.';
      return;
    }
    const next = upsertSavedLocation(saved, row);
    if (!persistSavedLocations(next)) {
      status.textContent =
        'Browser storage is unavailable. View was not saved.';
      return;
    }
    saved = next;
    input.value = '';
    status.textContent = `Saved ${row.name}.`;
    renderSaved();
  });

  function selectTab(key) {
    active = key;
    for (const id of Object.keys(pages)) {
      pages[id].hidden = id !== key;
      buttons[id].setAttribute('aria-selected', String(id === key));
      buttons[id].tabIndex = id === key ? 0 : -1;
    }
    weather.setVisible(!panel.hidden && key === 'weather');
    renderHealth();
  }
  function setOpen(open) {
    if (disposed) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    clearInterval(timer);
    timer = null;
    if (open) {
      keyboard.activate();
      selectTab(active);
      buttons[active].focus();
      timer = setInterval(renderHealth, 1000);
    } else {
      weather.setVisible(false);
      keyboard.deactivate({ restoreFocus: true });
    }
  }
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  for (const [id, button] of Object.entries(buttons)) {
    button.addEventListener('click', () => selectTab(id));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
        return;
      event.preventDefault();
      const keys = Object.keys(buttons);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? keys.length - 1
            : (keys.indexOf(id) +
                (event.key === 'ArrowRight' ? 1 : -1) +
                keys.length) %
              keys.length;
      selectTab(keys[index]);
      buttons[keys[index]].focus();
    });
  }
  const unsubscribe = dataManager.subscribe(renderHealth);
  const stopObservingMode = observeCommunityMode(documentRef.body, () =>
    setOpen(false),
  );
  renderSaved();
  selectTab(active);
  return {
    destroy() {
      disposed = true;
      restoreController?.abort();
      clearInterval(timer);
      unsubscribe();
      stopObservingMode();
      keyboard.destroy();
      weather.destroy();
      root.remove();
    },
  };
}
