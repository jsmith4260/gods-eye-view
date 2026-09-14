import { createTransitLayer as createLayer } from '../layers/transit/index.js';
import { createTransitSource } from '../layers/transit/source.js';
import * as render from '../renderGovernor.js';
import * as sprites from './spriteOrder.js';
import * as picking from './pickRegistry.js';
import * as overlays from '../overlays/worldOverlay.js';
import { registerDynamicCredit } from './dataCredits.js';
export * from '../layers/transit/index.js';
export { createTransitSource } from '../layers/transit/source.js';
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );
export function createTransitLayer(options = {}) {
  return createLayer({
    source: createTransitSource(),
    services: { render, sprites, picking, overlays },
    registerCredit(viewer, feed) {
      registerDynamicCredit(viewer, {
        key: `transit-${feed.id}`,
        html: `Transit: ${escapeHtml(feed.attribution)} — <a href="${escapeHtml(feed.licenseUrl)}" target="_blank" rel="noopener">${escapeHtml(feed.license)}</a>`,
      });
    },
    ...options,
  });
}
export default createTransitLayer();
