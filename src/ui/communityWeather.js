import {
  weatherPoint,
  formatTemperature,
  weatherCondition,
  boundedWeatherText,
} from '../data/communityWeatherModel.js';

/** Fetch ownership independent of DOM; hidden panels perform no network work. */
export function createWeatherController({
  getLocation,
  onChange = () => {},
  onStatus = () => {},
  fetchImpl = (...args) => fetch(...args),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  isDocumentVisible = () => typeof document === 'undefined' || !document.hidden,
} = {}) {
  let visible = false,
    destroyed = false,
    timer = null,
    request = null;
  let state = {
    location: null,
    forecast: null,
    hazards: null,
    unit: 'c',
    loading: false,
    error: null,
  };
  const emit = () => {
    onChange({ ...state });
    onStatus({
      enabled: visible,
      count: state.forecast?.days?.length || 0,
      lastUpdate: state.forecast?.fetchedAt || null,
      error: state.error,
      stale: state.forecast?.status === 'stale',
      loading: state.loading,
    });
  };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer =
      visible && !destroyed
        ? setTimer(() => {
            timer = null;
            void refresh();
          }, 60000)
        : null;
  };
  async function refresh(location = getLocation?.()) {
    if (!visible || destroyed) return;
    if (!isDocumentVisible()) {
      schedule();
      return;
    }
    const point = weatherPoint(location);
    if (!point) {
      state = {
        ...state,
        error: 'Choose a location on the map',
        loading: false,
      };
      emit();
      schedule();
      return;
    }
    request?.abort();
    const owned = new AbortController();
    request = owned;
    const changed =
      state.location?.latitude !== point.latitude ||
      state.location?.longitude !== point.longitude;
    state = {
      ...state,
      location: { ...point, label: boundedWeatherText(location?.label, 260) },
      loading: true,
      error: null,
      ...(changed ? { forecast: null, hazards: null } : {}),
    };
    emit();
    const query = new URLSearchParams(point);
    const fetchData = async (path) => {
      const response = await fetchImpl(`${path}?${query}`, {
        signal: AbortSignal.any([owned.signal, AbortSignal.timeout(18000)]),
      });
      if (!response.ok) throw new Error('Provider unavailable');
      return response.json();
    };
    const [forecast, hazards] = await Promise.allSettled([
      fetchData('/api/weather/forecast'),
      fetchData('/api/noaa/hazards'),
    ]);
    if (destroyed || !visible || request !== owned || owned.signal.aborted)
      return;
    request = null;
    const errors = [];
    if (
      forecast.status === 'fulfilled' &&
      forecast.value?.current &&
      Array.isArray(forecast.value.days)
    )
      state.forecast = forecast.value;
    else {
      errors.push('Forecast unavailable');
      if (state.forecast)
        state.forecast = { ...state.forecast, status: 'stale' };
    }
    if (
      hazards.status === 'fulfilled' &&
      Array.isArray(hazards.value?.alerts) &&
      Array.isArray(hazards.value?.reports)
    ) {
      state.hazards = hazards.value;
      if (hazards.value.sources?.nws?.status === 'unavailable')
        errors.push('NWS alerts unavailable');
      if (hazards.value.sources?.spc?.status === 'unavailable')
        errors.push('SPC reports unavailable');
    } else {
      errors.push('NOAA alerts and reports unavailable');
      state.hazards = null;
    }
    state = { ...state, loading: false, error: errors.join('; ') || null };
    emit();
    schedule();
  }
  return {
    refresh,
    getState: () => ({ ...state }),
    setUnit(unit) {
      state = { ...state, unit: unit === 'f' ? 'f' : 'c' };
      emit();
    },
    setVisible(value) {
      const next = Boolean(value);
      if (destroyed || next === visible) return;
      visible = next;
      if (visible) return refresh();
      request?.abort();
      request = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
      state = { ...state, loading: false };
      emit();
    },
    destroy() {
      destroyed = true;
      visible = false;
      request?.abort();
      request = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** Mount into an existing panel. Import communityWeather.css from the app entry. */
export function createWeatherPanel({
  container,
  getLocation,
  onFlyTo = () => {},
  onStatus,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  if (!container?.ownerDocument)
    throw new TypeError('Weather panel container is required');
  const doc = container.ownerDocument;
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text) => {
    const element = node('button', text);
    element.type = 'button';
    return element;
  };
  const root = node('div', undefined, 'community-weather');
  const actions = node('div', undefined, 'community-weather-actions');
  const refresh = button('Use map location'),
    celsius = button('°C'),
    fahrenheit = button('°F');
  actions.append(refresh, celsius, fahrenheit);
  const form = node('form', undefined, 'community-weather-search');
  const input = node('input');
  input.type = 'search';
  input.placeholder = 'Search a city';
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Search weather by city');
  const search = button('Search');
  search.type = 'submit';
  form.append(input, search);
  const results = node('div', undefined, 'community-weather-results');
  const searchStatus = node('p', undefined, 'community-weather-muted');
  searchStatus.setAttribute('role', 'status');
  const status = node(
    'p',
    'Open weather to load conditions',
    'community-weather-status',
  );
  status.setAttribute('role', 'status');
  const content = node('div');
  root.append(actions, form, searchStatus, results, status, content);
  container.append(root);
  let searchRequest = null,
    disposed = false;

  const measurement = (value, unit) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${Math.round(value * 10) / 10}${unit}`
      : '—';
  const sourceLink = (text, href) => {
    const a = node('a', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };
  const dateLabel = (value) => {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : 'Unknown time';
  };
  function render(state) {
    if (disposed) return;
    refresh.disabled = state.loading;
    celsius.setAttribute('aria-pressed', String(state.unit === 'c'));
    fahrenheit.setAttribute('aria-pressed', String(state.unit === 'f'));
    status.textContent = state.loading
      ? 'Loading weather and alerts…'
      : state.error || 'Updates every minute while this panel is open';
    status.dataset.error = String(Boolean(state.error));
    const nodes = [];
    if (state.location)
      nodes.push(
        node(
          'h3',
          state.location.label ||
            `${state.location.latitude.toFixed(3)}, ${state.location.longitude.toFixed(3)}`,
        ),
      );
    if (state.forecast) {
      const data = state.forecast;
      const current = node('section', undefined, 'community-weather-current');
      current.append(
        node('p', weatherCondition(data.current.code)),
        node(
          'strong',
          formatTemperature(data.current.temperature, state.unit),
          'community-weather-temperature',
        ),
        node(
          'p',
          `Feels like ${formatTemperature(data.current.apparent, state.unit)} · Humidity ${measurement(data.current.humidity, '%')}`,
        ),
        node(
          'p',
          `Wind ${measurement(data.current.wind, ' km/h')} · Precipitation ${measurement(data.current.precipitation, ' mm')}`,
        ),
        node(
          'p',
          `${data.status === 'stale' ? 'STALE · ' : ''}Model conditions ${data.current.time || 'time unavailable'} (${data.timezone || 'UTC'})`,
          'community-weather-muted',
        ),
      );
      nodes.push(current, node('h4', '7-day forecast'));
      const days = node('div', undefined, 'community-weather-days');
      for (const day of data.days.slice(0, 7)) {
        const article = node('article');
        const date = new Date(`${day.date}T12:00:00Z`);
        article.append(
          node(
            'strong',
            Number.isFinite(date.getTime())
              ? date.toLocaleDateString(undefined, {
                  weekday: 'short',
                  timeZone: 'UTC',
                })
              : day.date,
          ),
          node('small', day.date?.slice(5) || ''),
          node('span', weatherCondition(day.code)),
          node('b', formatTemperature(day.max, state.unit)),
          node('span', formatTemperature(day.min, state.unit)),
          node(
            'small',
            `Rain ${measurement(day.precipitationProbability, '%')}`,
          ),
        );
        days.append(article);
      }
      nodes.push(days);
    }
    nodes.push(
      node('h4', 'NWS active alerts at this location'),
      node(
        'p',
        'NWS coverage is United States and supported territories/waters.',
        'community-weather-muted',
      ),
    );
    const data = state.hazards;
    if (data) {
      const source = data.sources?.nws;
      nodes.push(
        node(
          'p',
          source?.status === 'unavailable'
            ? 'NWS unavailable — alert status unknown.'
            : `${source?.status === 'stale' ? 'STALE · ' : ''}${data.alerts.length} active alerts${data.limited ? ' (provider result limit reached)' : ''} · Retrieved ${dateLabel(source?.fetchedAt)}`,
          'community-weather-muted',
        ),
      );
      const alerts = node('div', undefined, 'community-weather-alerts');
      for (const alert of data.alerts.slice(0, 100)) {
        const details = node('details');
        details.append(
          node('summary', alert.event || 'Weather alert'),
          node('strong', alert.title),
          node('p', alert.area),
          node('p', `Expires ${dateLabel(alert.expires)}`),
          node('p', alert.description, 'community-weather-alert-text'),
        );
        if (alert.instruction)
          details.append(
            node('p', alert.instruction, 'community-weather-alert-text'),
          );
        if (!alert.geometry)
          details.append(
            node(
              'small',
              'Zone-based alert; no boundary supplied for the map.',
            ),
          );
        alerts.append(details);
      }
      if (data.alerts.length > 100)
        alerts.append(node('p', 'Showing the first 100 alerts.'));
      nodes.push(alerts);
      const reports = node('details', undefined, 'community-weather-reports');
      reports.append(
        node(
          'summary',
          `SPC preliminary storm reports · ${data.reports.length} across the US`,
        ),
      );
      reports.append(
        node(
          'p',
          `Completed reporting day ${data.reportDay || 'unknown'}: 12:00 UTC through 12:00 UTC the following day. Preliminary historical reports, subject to revision.`,
          'community-weather-muted',
        ),
      );
      if (data.sources?.spc?.status === 'unavailable')
        reports.append(node('p', 'SPC reports unavailable.'));
      else if (data.sources?.spc?.status === 'stale')
        reports.append(
          node('p', 'STALE · Showing the last retrieved reports.'),
        );
      for (const row of data.reports.slice(0, 100)) {
        const item = button(
          `${row.kind.toUpperCase()} · ${row.place} · ${dateLabel(row.time)}`,
        );
        item.addEventListener('click', () =>
          onFlyTo({
            latitude: row.latitude,
            longitude: row.longitude,
            label: row.place,
          }),
        );
        reports.append(item);
      }
      if (data.reports.length > 100)
        reports.append(
          node(
            'p',
            'Showing the first 100 reports; enable NOAA hazards to view report markers.',
          ),
        );
      nodes.push(reports);
    } else
      nodes.push(
        node(
          'p',
          state.loading
            ? 'Loading alerts…'
            : 'Alerts unavailable — status unknown.',
        ),
      );
    const credits = node('p', undefined, 'community-weather-muted');
    credits.append(
      sourceLink('Weather data by Open-Meteo.com', 'https://open-meteo.com/'),
      doc.createTextNode(' · '),
      sourceLink('NWS', 'https://www.weather.gov/'),
      doc.createTextNode(' · '),
      sourceLink('SPC reports', 'https://www.spc.noaa.gov/climo/reports/'),
    );
    nodes.push(credits);
    content.replaceChildren(...nodes);
  }
  const controller = createWeatherController({
    getLocation,
    fetchImpl,
    onChange: render,
    onStatus,
  });
  refresh.addEventListener('click', () => void controller.refresh());
  celsius.addEventListener('click', () => controller.setUnit('c'));
  fahrenheit.addEventListener('click', () => controller.setUnit('f'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (name.length < 2) {
      searchStatus.textContent = 'Enter at least two characters';
      return;
    }
    searchRequest?.abort();
    const owned = new AbortController();
    searchRequest = owned;
    search.disabled = true;
    searchStatus.textContent = 'Searching…';
    results.replaceChildren();
    try {
      const response = await fetchImpl(
        `/api/weather/search?${new URLSearchParams({ name })}`,
        { signal: AbortSignal.any([owned.signal, AbortSignal.timeout(18000)]) },
      );
      if (!response.ok) throw new Error('Search unavailable');
      const payload = await response.json();
      if (disposed || owned.signal.aborted || searchRequest !== owned) return;
      const matches = Array.isArray(payload.results)
        ? payload.results.slice(0, 5)
        : [];
      searchStatus.textContent = matches.length
        ? 'Choose a location'
        : 'No matching cities';
      for (const place of matches) {
        if (!weatherPoint(place)) continue;
        const item = button(place.label);
        item.addEventListener('click', () => {
          results.replaceChildren();
          searchStatus.textContent = '';
          onFlyTo(place);
          void controller.refresh(place);
        });
        results.append(item);
      }
    } catch {
      if (!disposed && !owned.signal.aborted)
        searchStatus.textContent =
          'City search unavailable; use the map location instead.';
    } finally {
      if (searchRequest === owned) {
        searchRequest = null;
        search.disabled = false;
      }
    }
  });
  return {
    refresh: controller.refresh,
    getState: controller.getState,
    setVisible(value) {
      if (!value) {
        searchRequest?.abort();
        searchRequest = null;
        search.disabled = false;
      }
      return controller.setVisible(value);
    },
    destroy() {
      disposed = true;
      searchRequest?.abort();
      controller.destroy();
      root.remove();
    },
  };
}
