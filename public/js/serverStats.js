'use strict';

let currentServerId = null;
let selectedHours = 24;
let playerChart = null;
let resourceChart = null;
let contextGeneration = 0;
let overviewController = null;
let chartController = null;
let overviewInFlight = false;
let refreshTimeout = null;
let nextRefreshAt = null;
let lastRefreshAt = null;
let serverClockOffsetMs = 0;
let chartLoadedAt = 0;

const GRID_COLOR = 'rgba(255,255,255,0.07)';
const TICK_COLOR = '#9ca3af';
const STATUS_STYLES = {
  healthy: 'border-green-700 bg-green-950 text-green-200',
  online: 'border-green-700 bg-green-950 text-green-200',
  running: 'border-blue-700 bg-blue-950 text-blue-200',
  degraded: 'border-yellow-700 bg-yellow-950 text-yellow-200',
  starting: 'border-yellow-700 bg-yellow-950 text-yellow-200',
  failed: 'border-red-700 bg-red-950 text-red-200',
  critical: 'border-red-700 bg-red-950 text-red-200',
  offline: 'border-red-700 bg-red-950 text-red-200',
  disabled: 'border-gray-600 bg-gray-800 text-gray-300',
  unknown: 'border-gray-600 bg-gray-800 text-gray-300',
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value ?? '—';
}

function validTime(value) {
  const milliseconds = value ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function exactTime(value) {
  const milliseconds = validTime(value);
  return milliseconds === null ? 'Never' : new Date(milliseconds).toLocaleString();
}

function relativeTime(value, now = Date.now() + serverClockOffsetMs) {
  const milliseconds = validTime(value);
  if (milliseconds === null) return 'Never';
  const seconds = Math.round((milliseconds - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 2) return 'now';
  if (absolute < 60) return seconds > 0 ? `in ${absolute}s` : `${absolute}s ago`;
  const minutes = Math.round(absolute / 60);
  if (minutes < 60) return seconds > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return seconds > 0 ? `in ${hours}h` : `${hours}h ago`;
}

function titleCase(value) {
  return String(value || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function statusBadge(state) {
  const normalized = String(state || 'unknown').toLowerCase();
  const span = document.createElement('span');
  span.className = `inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[normalized] || STATUS_STYLES.unknown}`;
  span.textContent = titleCase(normalized);
  return span;
}

function showBanner(message, type = 'error') {
  const element = byId('statusBanner');
  element.className = `mb-4 rounded-lg border p-4 text-sm ${type === 'error' ? STATUS_STYLES.failed : STATUS_STYLES.degraded}`;
  element.textContent = message;
}

function hideBanner() {
  byId('statusBanner').classList.add('hidden');
}

function setTimestamp(element, value, fallback = 'Never') {
  const milliseconds = validTime(value);
  element.textContent = milliseconds === null ? fallback : relativeTime(value);
  if (milliseconds === null) {
    element.removeAttribute('datetime');
    element.removeAttribute('title');
  } else {
    element.dateTime = new Date(milliseconds).toISOString();
    element.title = exactTime(value);
  }
}

function updateCountdownDisplays() {
  setText('lastRefresh', lastRefreshAt ? relativeTime(lastRefreshAt) : 'Never');
  if (document.visibilityState === 'hidden') {
    setText('nextRefresh', 'Paused while hidden');
  } else {
    setText('nextRefresh', nextRefreshAt ? relativeTime(nextRefreshAt) : 'Paused');
  }
  document.querySelectorAll('[data-countdown-at]').forEach(element => {
    const value = element.dataset.countdownAt;
    element.textContent = value ? relativeTime(value) : 'Not scheduled';
    element.title = value ? exactTime(value) : '';
  });
  document.querySelectorAll('[data-relative-at]').forEach(element => setTimestamp(element, element.dataset.relativeAt));
}

function clearServerView() {
  byId('healthContent').classList.add('hidden');
  byId('emptyState').classList.remove('hidden');
  byId('emptyState').textContent = currentServerId ? 'Loading server health…' : 'Select a server to view operational health and statistics.';
  setText('overallStatus', 'Unknown');
  setText('selectedServerLabel', currentServerId ? 'Loading…' : 'Select a server');
  lastRefreshAt = null;
  nextRefreshAt = null;
  destroyCharts();
}

function invalidateContext() {
  contextGeneration += 1;
  overviewController?.abort();
  chartController?.abort();
  overviewController = null;
  chartController = null;
  overviewInFlight = false;
  clearTimeout(refreshTimeout);
  refreshTimeout = null;
  chartLoadedAt = 0;
}

async function readJson(response, generation) {
  const result = await window.ServerStatsState.readJsonForContext(
    response,
    () => generation === contextGeneration
  );
  return result.stale ? null : result.body;
}

async function loadServers() {
  const select = byId('serverSelect');
  try {
    const response = await fetch('/api/nitrado/registered-servers');
    const data = await response.json();
    if (!response.ok || !data.success || !Array.isArray(data.servers)) throw new Error(data.error || 'Failed to load servers');
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = data.servers.length ? '— Pick a server —' : 'No servers found';
    select.appendChild(placeholder);
    data.servers.forEach(server => {
      const option = document.createElement('option');
      option.value = String(server.id);
      option.textContent = `${server.server_name} (${server.platform})`;
      select.appendChild(option);
    });
    select.disabled = data.servers.length === 0;
    select.addEventListener('change', onServerChange);
  } catch (error) {
    select.replaceChildren();
    const option = document.createElement('option');
    option.textContent = 'Error loading servers';
    select.appendChild(option);
    showBanner(error.message);
  }
}

function scheduleOverview(seconds) {
  clearTimeout(refreshTimeout);
  if (!currentServerId || document.visibilityState === 'hidden') return;
  const intervalSeconds = Math.max(10, Number(seconds) || 30);
  refreshTimeout = setTimeout(() => loadOverview(), intervalSeconds * 1000);
}

async function onServerChange() {
  invalidateContext();
  currentServerId = byId('serverSelect').value || null;
  byId('refreshButton').disabled = !currentServerId;
  clearServerView();
  hideBanner();
  if (!currentServerId) return;
  const generation = contextGeneration;
  await Promise.all([loadOverview({ generation, announce: true }), loadStats({ generation })]);
}

function setActiveRange(hours) {
  selectedHours = hours;
  document.querySelectorAll('.range-btn').forEach(button => {
    const active = Number.parseInt(button.dataset.hours, 10) === hours;
    button.setAttribute('aria-pressed', String(active));
    button.className = `range-btn rounded px-3 py-2 text-sm ${active ? 'bg-blue-600 font-semibold' : 'bg-gray-700 hover:bg-gray-600'}`;
  });
  setText('chartRangeLabel', `Last ${hours} hours`);
}

function renderCurrentServer(server) {
  setText('selectedServerLabel', server.name);
  setText('serverStatus', titleCase(server.status));
  setText('serverPlayers', server.players?.current == null ? 'Unavailable' : `${server.players.current} / ${server.players.maximum ?? '—'}`);
  setText('serverMap', server.map || 'Unavailable');
  setText('serverVersion', server.version || 'Unavailable');
  setText('serverPlatform', titleCase(server.platform));
  setText('serverStatusChanged', server.statusChangedAt ? relativeTime(server.statusChangedAt) : 'Unknown');
  const observed = byId('serverObservedAt');
  observed.dataset.relativeAt = server.observedAt || '';
  setTimestamp(observed, server.observedAt, 'Not observed');
}

function appendDefinition(list, label, value, options = {}) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  term.className = 'text-xs uppercase tracking-wide text-gray-400';
  term.textContent = label;
  const detail = options.time ? document.createElement('time') : document.createElement('dd');
  detail.className = 'mt-1 text-sm font-medium text-gray-100';
  if (options.time) {
    detail.dataset.relativeAt = value || '';
    setTimestamp(detail, value, options.fallback || 'Never');
  } else {
    detail.textContent = value ?? '—';
  }
  wrapper.append(term, detail);
  list.appendChild(wrapper);
}

function renderPipeline(id, title, description, pipeline) {
  const root = byId(id);
  root.replaceChildren();
  const header = document.createElement('div');
  header.className = 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between';
  const headingWrap = document.createElement('div');
  const heading = document.createElement('h3');
  heading.className = 'font-semibold';
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.className = 'text-xs text-gray-400';
  copy.textContent = description;
  headingWrap.append(heading, copy);
  header.append(headingWrap, statusBadge(pipeline?.state));

  const details = document.createElement('dl');
  details.className = 'mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6';
  appendDefinition(details, 'Cadence', pipeline?.intervalSeconds ? `${pipeline.intervalSeconds}s` : 'Disabled');
  appendDefinition(details, 'Last attempt', pipeline?.lastAttemptAt, { time: true });
  appendDefinition(details, 'Last success', pipeline?.lastSuccessAt || pipeline?.lastParseSuccessAt, { time: true });
  const next = document.createElement('div');
  const nextTerm = document.createElement('dt');
  nextTerm.className = 'text-xs uppercase tracking-wide text-gray-400';
  nextTerm.textContent = 'Next run';
  const nextValue = document.createElement('dd');
  nextValue.className = 'mt-1 text-sm font-medium tabular-nums text-gray-100';
  nextValue.dataset.countdownAt = pipeline?.nextRunAt || '';
  nextValue.textContent = pipeline?.enabled ? relativeTime(pipeline.nextRunAt) : 'Disabled';
  next.append(nextTerm, nextValue);
  details.appendChild(next);
  appendDefinition(details, 'Duration', pipeline?.durationMs == null ? '—' : `${pipeline.durationMs}ms`);
  const workload = window.ServerStatsState.pipelineWorkload(id, pipeline?.counters || {});
  appendDefinition(details, 'Workload', workload);
  root.append(header, details);
}

function renderServiceHealth(data) {
  const root = byId('serviceHealth');
  root.replaceChildren();
  const entries = [
    ['Dashboard API', data.service.api],
    ['Database', data.service.database],
    ['Discord bot', data.service.bot],
    ['Nitrado', data.health.components.nitrado],
    ['Discord integration', data.health.components.discord],
    ['Game server', data.health.components.gameServer],
  ];
  entries.forEach(([label, component]) => {
    const card = document.createElement('article');
    card.className = 'rounded-lg border border-gray-700 bg-gray-800 p-4';
    const heading = document.createElement('h3');
    heading.className = 'text-sm font-semibold';
    heading.textContent = label;
    const row = document.createElement('div');
    row.className = 'mt-2';
    row.appendChild(statusBadge(component?.stale ? 'unknown' : component?.state));
    const detail = document.createElement('p');
    detail.className = 'mt-2 text-xs text-gray-400';
    const timestamp = component?.checkedAt || component?.lastHeartbeatAt;
    detail.textContent = component?.stale ? `Stale · ${relativeTime(timestamp)}` : (component?.message || relativeTime(timestamp));
    card.append(heading, row, detail);
    root.appendChild(card);
  });
}

function renderCeLoop(summary) {
  const root = byId('ceLoopSummary');
  root.replaceChildren();
  const headline = document.createElement('div');
  headline.className = 'text-3xl font-bold tabular-nums';
  headline.textContent = summary.latestDurationSeconds == null ? 'No data' : `${summary.latestDurationSeconds.toFixed(2)}s`;
  const caption = document.createElement('p');
  caption.className = 'text-xs text-gray-400';
  caption.textContent = summary.latestAt ? `Latest loop ${relativeTime(summary.latestAt)}` : 'No CE loop observations in the last 24 hours.';
  const detail = document.createElement('p');
  detail.className = 'mt-3 text-sm text-gray-300';
  detail.textContent = summary.sampleCount
    ? `${summary.sampleCount} samples · avg ${summary.averageDurationSeconds?.toFixed(2) ?? '—'}s · p95 ${summary.p95DurationSeconds?.toFixed(2) ?? '—'}s · max ${summary.maxDurationSeconds?.toFixed(2) ?? '—'}s`
    : 'Telemetry will appear after a complete RPT parse.';
  const counts = document.createElement('p');
  counts.className = 'mt-2 text-xs text-gray-400';
  counts.textContent = summary.sampleCount
    ? `Players ${summary.latestCounts.players ?? '—'} · Loot ${summary.latestCounts.loot ?? '—'} · Infected ${summary.latestCounts.infected ?? '—'} · Animals ${summary.latestCounts.animals ?? '—'}`
    : '';
  root.append(headline, caption, detail, counts);
}

function renderAttention(data) {
  const messages = [];
  const warningMessages = {
    NITRADO_UNAVAILABLE: 'Live Nitrado status is temporarily unavailable.',
    NITRADO_TOKEN_UNAVAILABLE: 'No usable Nitrado token is available for this server.',
    RPT_TELEMETRY_EMPTY: 'No CE-loop telemetry was observed in the last 24 hours.',
  };
  data.warnings.forEach(code => messages.push(warningMessages[code] || 'One data source is unavailable.'));
  Object.entries(data.pipelines).forEach(([name, pipeline]) => {
    if (pipeline.enabled && ['failed', 'degraded'].includes(pipeline.state)) messages.push(`${titleCase(name)} needs attention.`);
    if (pipeline.enabled && pipeline.overdue) messages.push(`${titleCase(name)} is overdue.`);
  });
  if ((data.pipelines.feedProcessor?.counters?.failed || 0) > 0) messages.push('One or more feed deliveries reached a terminal failure.');
  const panel = byId('attentionPanel');
  const list = byId('attentionList');
  list.replaceChildren();
  messages.forEach(message => {
    const item = document.createElement('li');
    item.textContent = message;
    list.appendChild(item);
  });
  panel.classList.toggle('hidden', messages.length === 0);
}

function renderOverview(data) {
  byId('emptyState').classList.add('hidden');
  byId('healthContent').classList.remove('hidden');
  const overall = byId('overallStatus');
  overall.className = `rounded-full border px-3 py-1 text-sm font-semibold ${STATUS_STYLES[data.health.overall] || STATUS_STYLES.unknown}`;
  overall.textContent = titleCase(data.health.overall);
  renderCurrentServer(data.server);
  renderPipeline('pipelineLowLatency', 'Low-latency ADM parser', 'Fast player and kill ingestion', data.pipelines.lowLatencyAdm);
  renderPipeline('pipelineFullSync', 'Full ADM/RPT sync and parser', 'Complete historical and telemetry scan', data.pipelines.fullLogSync);
  renderPipeline('pipelineFeed', 'Discord feed processor', 'Queued event delivery', data.pipelines.feedProcessor);
  renderServiceHealth(data);
  renderCeLoop(data.ceLoop);
  renderAttention(data);
  updateCountdownDisplays();
}

async function loadOverview({ generation = contextGeneration, announce = false } = {}) {
  if (!currentServerId || overviewInFlight || document.visibilityState === 'hidden') return;
  overviewInFlight = true;
  const selectedServerId = currentServerId;
  overviewController = new AbortController();
  try {
    const response = await fetch(`/api/stats/${encodeURIComponent(selectedServerId)}/overview`, {
      signal: overviewController.signal,
    });
    if (generation !== contextGeneration || selectedServerId !== currentServerId) return;
    const data = await readJson(response, generation);
    if (!data || selectedServerId !== currentServerId) return;
    const generatedMs = validTime(data.generatedAt);
    if (generatedMs !== null) serverClockOffsetMs = generatedMs - Date.now();
    lastRefreshAt = data.generatedAt;
    nextRefreshAt = data.refresh?.nextRefreshAt || null;
    renderOverview(data);
    hideBanner();
    if (announce) byId('refreshAnnouncement').textContent = `Server health refreshed. Overall state ${data.health.overall}.`;
    const chartAge = Date.now() - chartLoadedAt;
    if (chartAge >= 5 * 60 * 1000) loadStats({ generation }).catch(() => {});
    scheduleOverview(data.refresh?.recommendedIntervalSeconds);
  } catch (error) {
    if (error.name !== 'AbortError' && generation === contextGeneration) {
      showBanner(`Health refresh failed. Showing the last successful data when available. ${error.message}`);
      byId('refreshAnnouncement').textContent = 'Server health refresh failed.';
      scheduleOverview(30);
    }
  } finally {
    if (generation === contextGeneration) overviewInFlight = false;
  }
}

function destroyCharts() {
  if (playerChart) playerChart.destroy();
  if (resourceChart) resourceChart.destroy();
  playerChart = null;
  resourceChart = null;
}

function numericSummary(values, suffix = '') {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return 'No samples available.';
  const current = numbers[numbers.length - 1];
  const average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const peak = Math.max(...numbers);
  return `Current ${current.toFixed(1)}${suffix} · Average ${average.toFixed(1)}${suffix} · Peak ${peak.toFixed(1)}${suffix}`;
}

function renderCharts(data) {
  destroyCharts();
  const labels = data.labels || [];
  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { labels: { color: '#e5e7eb' } } },
    scales: { x: { ticks: { color: TICK_COLOR, maxTicksLimit: 8, maxRotation: 0 }, grid: { color: GRID_COLOR } } },
  };
  playerChart = new Chart(byId('playerChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Players', data: data.players || [], borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.15)', fill: true, tension: 0.25, pointRadius: 0 },
      { label: 'Max slots', data: data.maxPlayers || [], borderColor: '#6b7280', borderDash: [5, 5], fill: false, pointRadius: 0 },
    ] },
    options: { ...baseOptions, scales: { ...baseOptions.scales, y: { min: 0, ticks: { color: TICK_COLOR, precision: 0 }, grid: { color: GRID_COLOR } } } },
  });
  resourceChart = new Chart(byId('resourceChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'CPU %', data: data.cpu || [], borderColor: '#f59e0b', fill: false, tension: 0.25, pointRadius: 0 },
      { label: 'Memory %', data: data.memory || [], borderColor: '#818cf8', fill: false, tension: 0.25, pointRadius: 0 },
    ] },
    options: { ...baseOptions, scales: { ...baseOptions.scales, y: { min: 0, max: 100, ticks: { color: TICK_COLOR, callback: value => `${value}%` }, grid: { color: GRID_COLOR } } } },
  });
  setText('playerSummary', numericSummary(data.players || []));
  setText('resourceSummary', `CPU: ${numericSummary(data.cpu || [], '%')} · Memory: ${numericSummary(data.memory || [], '%')}`);
}

async function loadStats({ generation = contextGeneration } = {}) {
  if (!currentServerId || document.visibilityState === 'hidden') return;
  chartController?.abort();
  chartController = new AbortController();
  const selectedServerId = currentServerId;
  try {
    const response = await fetch(`/api/stats/${encodeURIComponent(selectedServerId)}?hours=${selectedHours}`, {
      signal: chartController.signal,
    });
    if (generation !== contextGeneration || selectedServerId !== currentServerId) return;
    const data = await readJson(response, generation);
    if (!data || selectedServerId !== currentServerId) return;
    renderCharts(data);
    chartLoadedAt = Date.now();
  } catch (error) {
    if (error.name !== 'AbortError' && generation === contextGeneration) {
      showBanner(`Performance history could not be refreshed. ${error.message}`);
    }
  }
}

byId('refreshButton').addEventListener('click', () => {
  if (!currentServerId) return;
  loadOverview({ announce: true });
  loadStats();
});

document.querySelectorAll('.range-btn').forEach(button => {
  button.addEventListener('click', () => {
    setActiveRange(Number.parseInt(button.dataset.hours, 10));
    loadStats();
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
    overviewController?.abort();
    chartController?.abort();
    updateCountdownDisplays();
    return;
  }
  if (currentServerId) loadOverview({ announce: true });
});

setInterval(() => updateCountdownDisplays(), 1000);
setActiveRange(selectedHours);
clearServerView();
loadServers();
