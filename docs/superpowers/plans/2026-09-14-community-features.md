# Community features implementation plan

This is the completed implementation record from the original ZIP installation, before the customized source was connected to the fork. The constraints and decisions below describe that implementation phase. Public source revisions are listed in [Community additions](../../COMMUNITY-FEATURES.md#source-provenance).

**Goal:** Integrate the user-approved saved views, provider health, weather forecasts, NOAA hazards, seven-network public transit, and keyless ship tracking into the existing CCTV-expanded Windows installation.

**Architecture:** Adapt small feature modules to the current application composition and manager lifecycle. Reuse the existing layer registry, browser storage, Cesium rendering, and local provider infrastructure. Keep the original source backup and an immutable provenance record outside the app.

**Tech stack:** Existing Node 26, JavaScript ES modules, Cesium, Vite, pbf, Node test runner. No new dependencies planned.

**Specification:** The user's approved feature table and linked PRs #358, #366, #405, #414, #218 and Ghost Edition's keyless vessel behavior. Saved views include camera position/orientation, map source, and layer selection/options. Health reports actual feed states, counts, ages and retries. Forecasts include current conditions and seven days with unit switching; NOAA includes alerts and explicitly dated preliminary storm reports. Transit covers the seven source networks. Keyless vessels preserve optional AISStream and existing vessel inspection.

## Global constraints

- Preserve CCTV revision 8d9a1f00794cd41b4e377cf0009b8b81991cd2ad and the local Windows permission fix.
- The downloaded app had no Git metadata during implementation; source backups and hash manifests recorded the changes without inventing a branch history.
- Review and pin community sources; no package changes or lifecycle execution without review.
- Keep provider destinations fixed, validate inputs, cap responses and caches, set timeouts, and implement dev and preview middleware.
- Treat remote payload text as untrusted. No fabricated data or successful health states on failure.
- Stop requests/listeners on disable/destroy and avoid stale responses reviving disabled layers.
- No credentials, public deployment, external repository mutation, or unrelated installation changes.

## Tasks

- [x] Saved views: create `src/savedLocations.js` and behavior tests for strict bounded storage, persistence failures, deletion and layer options. Add a small UI controller with Save, Restore and Delete. Restore through current navigation/layer APIs; test malformed and unavailable storage.
- [x] Provider health: create `src/providerHealth.js` and tests for disabled/loading/stale/degraded/key-required states, counts and retry times; create safe, accessible UI rendering subscribed to manager updates. Include individual transit/provider rows where supplied.
- [x] Weather/NOAA: weather agent owns focused forecast, hazard, proxy and test modules. Root mounts the panel, registers the layer, adds its serialization token and provider plugins. Test normalization, bounds, failures, dates, and cancellation.
- [x] Transit: transit agent owns GTFS normalization, seven fixed feeds, layer, proxy and tests. Root registers the layer, serialization token, sprite order and proxy. Test bad coordinates, stale contacts, per-feed failures and cleanup.
- [x] Vessels: ship agent reviews Ghost source and independently implements unlicensed behavior where necessary. Root wires the fixed OpenWaters proxy. Retain AISStream compatibility, existing vessel cards and tracking. Test bounds, parsing, fallback/source errors and cleanup.
- [x] Integration: root handles shared `src/standalone/tools.js`, `src/standalone/data.js`, `src/data/layerState.js`, `server/providers/local.js`, and standalone stylesheet imports. Verify actual feature controls, data and persistence in the browser.
- [x] Validation/review: focused tests first, then formatting, boundaries, full compatible unit plan and production build; independent review of implemented modules and shared wiring. Smoke-test live keyless routes and production preview. Record upstream outages honestly and stop temporary servers.

## Ownership and interface review

| Tasks | Shared boundary | Decision |
|---|---|---|
| Weather, transit, ships | Local Vite provider plugin registry | Agents export plugins; root alone modifies registry. |
| Weather, transit, saved views | Layer serialization | Root assigns unique tokens and tests round trips. |
| Health and data sources | `getStats()` / `getAll()` | Consume existing manager states plus optional `feedHealth` children. |
| All UI features | Standalone tools and lifecycle | Root mounts after data registration and registers teardown immediately. |
| All source work | Baseline and package runtime | Source-only backup; preserve locked dependencies and trusted junction. |

## Progress ledger

- Source snapshot begun before edits. Source review pinned saved views to 359628deb4901fcab9d736ac2b4c53b32d9b0cbd and health to 065011497ecb2a437623df216090e2e08bfe5b0d; neither changes dependencies or lifecycle scripts.
- Ruling at implementation time: work within the existing downloaded copy, with rollback artifacts, because it was the user's authorized installation and did not yet have a Git repository.
- Ruling: the approved feature implementations define the design; proceed without an additional design-approval pause.



- Complete at implementation time: 3,391 tests passed, zero failed, six skipped across 253 files; two Node 24 allocation files excluded. Formatting (499 files), boundaries, production build and actual preview provider routes passed. Browser saved-view restoration and live transit/NOAA/weather/ships verified. Temporary servers stopped. These are historical validation results, not a claim about current provider availability.
