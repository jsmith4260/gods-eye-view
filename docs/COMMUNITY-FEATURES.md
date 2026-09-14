# Community additions

This installation combines the expanded CCTV branch with saved views, feed health, weather, NOAA hazards, seven transit networks and keyless regional ships. Dependencies are unchanged.

## Open the app

Open PowerShell in the repository directory containing `package.json`, then run:

```powershell
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort --configLoader native
```

Open [God's Eye View locally](http://127.0.0.1:4173/). Choose **Explore Manually** if the welcome screen appears.

## Views and feeds

The **VIEWS & FEEDS** button is at the bottom right, above provider settings.

- **Saved views:** name and save the current camera, map source and layer settings; click a saved name to restore it or Delete to remove it. Up to 24 views are stored in this browser on this origin. Clearing browser data removes them. Tracking a moving contact is intentionally excluded. Unavailable map sources and failed layer changes are reported during restoration.
- **Feed health:** shows enabled/off, loading, live, waiting, stale and failed states, counts, last-update age and provider details. Transit and NOAA expose individual feeds. Disabled layers are not fetched just to test health. A successful empty response does not imply complete geographic coverage.
- **Weather:** current model conditions and seven daily forecasts for the map location, city search, temperature units and local NWS alerts. **Use map location** refreshes for the current view; selecting a city also flies there. Updates run while the panel is visible. Provider errors remain visible; conditions and warnings are not fabricated.

## New globe layers

Expand **DATA LAYERS** to enable:

| Layer | Coverage and behavior |
|---|---|
| **Transit** | MBTA/Boston; CapMetro/Austin; Metro Transit/Minneapolis–St Paul; HSL/Helsinki; OVapi/Netherlands; Entur/Norway; TransLink/South East Queensland. Navigate into a covered region and zoom below about 3,000 km altitude. Only nearby feeds are polled. Vehicle markers expose available route, operator and observation details. Most feeds refresh around 15 seconds; OVapi around 60 seconds. |
| **NOAA Alerts & Storm Reports** | NWS active US alerts with supplied map geometry and preliminary SPC tornado, wind and hail reports. Alerts without geometry remain available in the weather panel. SPC reports cover the last completed 12:00–12:00 UTC reporting day and are explicitly historical, not current warnings. |
| **Live AIS Vessels** | Automatically uses keyless OpenWaters regional snapshots when no AISStream configuration is supplied. Start near a busy coastal area such as Portsmouth or Rotterdam. Coverage depends on receivers; a regional request is bounded to 2 degrees of latitude by 4 degrees of longitude and 2,000 contacts, with positions expiring after five minutes. Available ship cards retain source and observation details. |

The Ghost Edition addition is its keyless ship behavior adapted into this app. Its entire experimental fork is not substituted for the maintained CCTV installation. OpenWaters does not supply a global historical replay here; trails show observations collected during this session.

Existing AISStream keys and explicit custom AIS endpoints remain supported. The optional `VITE_VESSEL_SOURCE` setting accepts `auto`, `openwaters` or `aisstream`; setting it explicitly overrides automatic compatibility selection. Keep credentials in the existing provider settings workflow, never in saved views.

All source credits remain in **Data attribution**. Public API availability and coverage can change; the health panel reports failures. Source terms are documented in [DATA_SOURCES.md](../DATA_SOURCES.md).

## Source provenance

The original installation came from a ZIP matching upstream main `ba7fda74d7e337aebcc7e2db27ee1a4ed0b3926c`. The CCTV changes were applied from the pinned revision below, followed by a Windows provider-key permission repair and community features adapted to this application's architecture. These features were implemented before the source was connected to the fork; they are not represented as merges of the referenced pull requests.

| Feature | Reviewed source revision |
|---|---|
| Expanded CCTV, PR #433 | [`8d9a1f00794cd41b4e377cf0009b8b81991cd2ad`](https://github.com/bilawalsidhu/gods-eye-view/commit/8d9a1f00794cd41b4e377cf0009b8b81991cd2ad) |
| Saved views, PR #358 | [`359628deb4901fcab9d736ac2b4c53b32d9b0cbd`](https://github.com/bilawalsidhu/gods-eye-view/commit/359628deb4901fcab9d736ac2b4c53b32d9b0cbd) |
| Provider health, PR #366 | [`065011497ecb2a437623df216090e2e08bfe5b0d`](https://github.com/bilawalsidhu/gods-eye-view/commit/065011497ecb2a437623df216090e2e08bfe5b0d) |
| Weather, PR #405 | [`60e4cad7152b3aeb3df049b771e6b8eaa1cb5768`](https://github.com/bilawalsidhu/gods-eye-view/commit/60e4cad7152b3aeb3df049b771e6b8eaa1cb5768) |
| NOAA, PR #414 | [`e5ee6c6b40c817fef4dd311faa23d2fec8eabb16`](https://github.com/bilawalsidhu/gods-eye-view/commit/e5ee6c6b40c817fef4dd311faa23d2fec8eabb16) |
| Transit, PR #218 | [`481e4f09e6958589551932491c14a08d998789bb`](https://github.com/bilawalsidhu/gods-eye-view/commit/481e4f09e6958589551932491c14a08d998789bb) |
| Keyless ship behavior, Ghost Edition | [`2c4de78b4643a4f86e934cd37bcbd25540bca3f3`](https://github.com/Gh0st-mods/Gods-Eye-Ghost-Edition/commit/2c4de78b4643a4f86e934cd37bcbd25540bca3f3) |

The OpenWaters response contract was implemented independently after reviewing Ghost Edition's keyless ship behavior. Package versions and lifecycle scripts were preserved throughout the integration.
