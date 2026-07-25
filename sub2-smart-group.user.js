// ==UserScript==
// @name         Sub2 & AIHub Smart Group
// @name:zh-CN   Sub2 与 AIHub 智能分组
// @namespace    local.sub2.smart-group
// @version      1.2.0
// @description  AIHub group recommendation + sub2api account health and routing management (based on real traffic, no active probing).
// @description:zh-CN 保留 AIHub 智能分组；并为 sub2api 增加基于真实流量的账号健康度可视化与路由管理（不主动测活）
// @license      MIT
// @homepageURL   https://github.com/hong594/sub2-smart-group
// @supportURL    https://github.com/hong594/sub2-smart-group/issues
// @updateURL     https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js
// @downloadURL   https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js
// @match        https://aihub.top/*
// @match        http://localhost:18080/*
// @match        http://127.0.0.1:18080/*
// @match        http://localhost:8080/*
// @match        http://127.0.0.1:8080/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

//
// 说明：本脚本默认匹配 localhost:18080 / 8080 等本地地址。
// 如果你通过内网 IP、自定义域名或 HTTPS 访问 sub2api 后台，请自行补一行 @match，例如：
//   // @match http://192.168.x.x:18080/*
//   // @match https://your-sub2-domain.com/*
// 脚本在 aihub.top 上的行为与原版完全一致；其它匹配站点会尝试识别为 sub2api 后台。

/* global module */

(function (factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') exported.start();
})(function () {
  'use strict';

  const ROOT_ID = 'aihub-smart-group-panel';
  const TOGGLE_ID = 'aihub-smart-group-toggle';
  const SCRIPT_VERSION = '0.5.8';
  const STORAGE_PREFIX = 'aihub-smart-group:';
  const GROUP_MODE_LABELS = Object.freeze({
    price: '价格',
    balance: '平衡',
    speed: '速度',
  });
  const DEFAULT_CONFIG = Object.freeze({
    minSuccess10m: 0.10,
    requireNoWarnings: true,
    consecutiveChecks: 2,
    pollIntervalSeconds: 30,
    cooldownMinutes: 10,
    autoSwitch: false,
    mode: 'price',
    balanceMaxPrice: 0.1,
    excludedGroupKeywords: '',
    maxMonitorAgeSeconds: 600,
    availabilityMode: 'percent',
    minSuccessPoints10m: 1,
    minConsecutiveSuccesses10m: 2,
  });

  function numberOr(value, fallback) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeExcludedGroupKeywords(value) {
    const source = Array.isArray(value) ? value.join('|') : String(value ?? '');
    const seen = new Set();
    return source.split('|')
      .map((keyword) => keyword.trim().toLocaleLowerCase())
      .filter((keyword) => {
        if (!keyword || seen.has(keyword)) return false;
        seen.add(keyword);
        return true;
      })
      .join('|');
  }

  function normalizeConfig(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      minSuccess10m: clamp(numberOr(source.minSuccess10m, DEFAULT_CONFIG.minSuccess10m), 0, 1),
      requireNoWarnings: source.requireNoWarnings !== false,
      consecutiveChecks: Math.round(clamp(numberOr(source.consecutiveChecks, DEFAULT_CONFIG.consecutiveChecks), 1, 5)),
      pollIntervalSeconds: Math.round(clamp(numberOr(source.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds), 10, 3600)),
      cooldownMinutes: clamp(numberOr(source.cooldownMinutes, DEFAULT_CONFIG.cooldownMinutes), 0, 1440),
      autoSwitch: source.autoSwitch === true,
      mode: normalizeGroupMode(source.mode),
      balanceMaxPrice: clamp(numberOr(source.balanceMaxPrice, DEFAULT_CONFIG.balanceMaxPrice), 0, 1000),
      excludedGroupKeywords: normalizeExcludedGroupKeywords(source.excludedGroupKeywords),
      maxMonitorAgeSeconds: DEFAULT_CONFIG.maxMonitorAgeSeconds,
      availabilityMode: normalizeAvailabilityMode(source.availabilityMode),
      minSuccessPoints10m: Math.round(clamp(numberOr(source.minSuccessPoints10m, DEFAULT_CONFIG.minSuccessPoints10m), 1, 60)),
      minConsecutiveSuccesses10m: Math.round(clamp(numberOr(source.minConsecutiveSuccesses10m, DEFAULT_CONFIG.minConsecutiveSuccesses10m), 1, 60)),
    };
  }

  function normalizeGroupMode(value) {
    return Object.prototype.hasOwnProperty.call(GROUP_MODE_LABELS, value) ? value : 'price';
  }

  function normalizePanelTab(value) {
    return value === 'logs' ? 'logs' : 'settings';
  }

  function normalizeAvailabilityMode(value) {
    return value === 'successes' || value === 'consecutive' ? value : 'percent';
  }

  function getBalanceAmount(payload) {
    const value = Number(payload?.data?.balance ?? payload?.balance);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function formatBalance(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0
      ? amount.toFixed(6).replace(/\.?0+$/, '')
      : '暂无数据';
  }

  function getExcludedGroupInfo(rows, keywordInput) {
    const keywords = normalizeExcludedGroupKeywords(keywordInput).split('|').filter(Boolean);
    const matches = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = String(row?.planType || row?.name || '').trim();
      const normalizedName = name.toLocaleLowerCase();
      if (!name || !keywords.some((keyword) => normalizedName.includes(keyword))) continue;
      const identity = `${row?.group_id ?? ''}:${normalizedName}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      matches.push({ row, name });
    }
    return { keywords, matches };
  }

  function analyzeCandidates(rows, config = DEFAULT_CONFIG) {
    const normalizedConfig = normalizeConfig(config);
    const excludedKeywords = normalizedConfig.excludedGroupKeywords.split('|').filter(Boolean);
    const sourceRows = Array.isArray(rows) ? rows : [];
    const counts = { total: sourceRows.length, invalid: 0, unavailable: 0, lowSuccess: 0, warnings: 0, keywords: 0, eligible: 0 };
    const candidates = [];
    for (const row of sourceRows) {
      const groupId = Number(row?.group_id);
      const price = Number(row?.priceMultiplier);
      if (!row || !Number.isInteger(groupId) || groupId <= 0 || !Number.isFinite(price) || price < 0) {
        counts.invalid += 1;
        continue;
      }
      if (row.enabled === false || row.available !== true) {
        counts.unavailable += 1;
        continue;
      }
      const success10m = Number(row.successRates?.['10m']);
      const recentSuccessCount = Number(row.recentSuccessCount);
      const recentConsecutiveSuccessCount = Number(row.recentConsecutiveSuccessCount);
      const availabilityPasses = normalizedConfig.availabilityMode === 'successes'
        ? Number.isFinite(recentSuccessCount) && recentSuccessCount >= normalizedConfig.minSuccessPoints10m
        : normalizedConfig.availabilityMode === 'consecutive'
          ? Number.isFinite(recentConsecutiveSuccessCount) && recentConsecutiveSuccessCount >= normalizedConfig.minConsecutiveSuccesses10m
          : Number.isFinite(success10m) && success10m >= normalizedConfig.minSuccess10m;
      if (!availabilityPasses) {
        counts.lowSuccess += 1;
        continue;
      }
      if (normalizedConfig.requireNoWarnings && Array.isArray(row.warningReasons) && row.warningReasons.length > 0) {
        counts.warnings += 1;
        continue;
      }
      const name = String(row.planType || row.name || `Group ${row.group_id}`);
      if (excludedKeywords.some((keyword) => name.toLocaleLowerCase().includes(keyword))) {
        counts.keywords += 1;
        continue;
      }
      candidates.push({
        ...row,
        groupId,
        price,
        success10m,
        latency: Number.isFinite(Number(row.firstTokenLatencyMs)) ? Number(row.firstTokenLatencyMs) : Number.POSITIVE_INFINITY,
        name,
      });
      counts.eligible += 1;
    }
    return { candidates, counts };
  }

  function getEligibleCandidates(rows, normalizedConfig) {
    return analyzeCandidates(rows, normalizedConfig).candidates;
  }

  function comparePrice(left, right) {
    return left.price - right.price
      || right.success10m - left.success10m
      || left.latency - right.latency
      || left.name.localeCompare(right.name);
  }

  function compareSpeed(left, right) {
    return left.latency - right.latency
      || left.price - right.price
      || right.success10m - left.success10m
      || left.name.localeCompare(right.name);
  }

  function rankCandidates(rows, config = DEFAULT_CONFIG) {
    const normalizedConfig = normalizeConfig(config);
    const candidates = getEligibleCandidates(rows, normalizedConfig);
    if (normalizedConfig.mode === 'speed') return candidates.sort(compareSpeed);
    if (normalizedConfig.mode === 'balance') return candidates.filter((candidate) => candidate.price <= normalizedConfig.balanceMaxPrice).sort(compareSpeed);
    return candidates.sort(comparePrice);
  }

  function formatRelativeAge(ageMs) {
    if (!Number.isFinite(ageMs)) return '时间未知';
    const seconds = Math.max(0, Math.floor(ageMs / 1000));
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时前`;
  }

  function getMonitorFreshness(generatedAt, now = Date.now(), maxAgeSeconds = DEFAULT_CONFIG.maxMonitorAgeSeconds) {
    const parsed = typeof generatedAt === 'number' ? generatedAt : Date.parse(generatedAt);
    if (!Number.isFinite(parsed)) return { generatedAt: null, ageMs: null, stale: true, label: '时间未知' };
    const ageMs = Math.max(0, Number(now) - parsed);
    return {
      generatedAt: parsed,
      ageMs,
      stale: ageMs > Math.max(0, Number(maxAgeSeconds) || 0) * 1000,
      label: formatRelativeAge(ageMs),
    };
  }

  function getLatestMonitorSampleAt(seriesPayload) {
    let latest = null;
    for (const samples of Object.values(seriesPayload?.seriesByApiId || {})) {
      for (const sample of Array.isArray(samples) ? samples : []) {
        const timestamp = Number(sample?.[0]);
        if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) latest = timestamp;
      }
    }
    return latest;
  }

  function formatRemainingTime(remainingMs) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  }

  function getCooldownInfo(lastSwitchAt, cooldownMinutes, now = Date.now()) {
    const cooldownMs = Math.max(0, Number(cooldownMinutes) || 0) * 60 * 1000;
    const lastAt = Number(lastSwitchAt);
    const remainingMs = Number.isFinite(lastAt) ? Math.max(0, lastAt + cooldownMs - Number(now)) : 0;
    return { remainingMs, active: remainingMs > 0, label: remainingMs > 0 ? `剩余 ${formatRemainingTime(remainingMs)}` : '冷却已结束' };
  }

  function attachRecentAvailability(rows, seriesPayload, windowMs = 10 * 60 * 1000) {
    const generatedAt = Date.parse(seriesPayload?.generatedAt);
    const now = Number.isFinite(generatedAt) ? generatedAt : Date.now();
    const cutoff = now - Math.max(1, Number(windowMs) || 1);
    const seriesByApiId = seriesPayload?.seriesByApiId || {};
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const samples = Array.isArray(seriesByApiId[row?.id]) ? seriesByApiId[row.id] : [];
      const recent = samples.filter((sample) => {
        const at = Number(sample?.[0]);
        return Number.isFinite(at) && at >= cutoff && at <= now && (sample?.[1] === 0 || sample?.[1] === 1);
      });
      const successes = recent.filter((sample) => sample[1] === 1).length;
      const orderedRecent = recent.slice().sort((left, right) => Number(left[0]) - Number(right[0]));
      let trailingSuccesses = 0;
      for (let index = orderedRecent.length - 1; index >= 0 && orderedRecent[index][1] === 1; index -= 1) trailingSuccesses += 1;
      return {
        ...row,
        successRates: {
          ...(row?.successRates || {}),
          '10m': recent.length ? successes / recent.length : Number.NaN,
        },
        recentSampleCount: recent.length,
        recentSuccessCount: successes,
        recentConsecutiveSuccessCount: trailingSuccesses,
      };
    });
  }

  function normalizeGroupName(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
  }

  function buildGroupMultiplierMap(rows) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = normalizeGroupName(row?.planType || row?.name);
      const multiplier = Number(row?.priceMultiplier);
      if (name && Number.isFinite(multiplier) && multiplier >= 0) result.set(name, multiplier);
    }
    return result;
  }

  function nonNegativeNumberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function buildGroupMetricMap(rows) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const groupId = Number(row?.group_id);
      if (!Number.isInteger(groupId) || groupId <= 0) continue;
      result.set(groupId, {
        multiplier: nonNegativeNumberOrNull(row?.priceMultiplier),
        latencyMs: nonNegativeNumberOrNull(row?.firstTokenLatencyMs),
      });
    }
    return result;
  }

  function normalizeGroupMonitorMultiplier(value) {
    const multiplier = nonNegativeNumberOrNull(value);
    return multiplier === null ? '' : multiplier.toFixed(6);
  }

  function groupDropdownMonitorKey(name, multiplier) {
    const normalizedName = normalizeGroupName(name);
    const normalizedMultiplier = normalizeGroupMonitorMultiplier(multiplier);
    return normalizedName && normalizedMultiplier ? `${normalizedName}|${normalizedMultiplier}` : '';
  }

  function newerMonitorRow(current, candidate) {
    if (!current) return candidate;
    const currentAt = Date.parse(current.checkedAt);
    const candidateAt = Date.parse(candidate.checkedAt);
    return Number.isFinite(candidateAt) && (!Number.isFinite(currentAt) || candidateAt > currentAt) ? candidate : current;
  }

  function buildGroupDropdownMonitorIndex(rows) {
    const byComposite = new Map();
    const byName = new Map();
    const ambiguousNames = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = normalizeGroupName(row?.planType || row?.name);
      if (!name) continue;
      const compositeKey = groupDropdownMonitorKey(name, row?.priceMultiplier);
      if (compositeKey) byComposite.set(compositeKey, newerMonitorRow(byComposite.get(compositeKey), row));
      if (byName.has(name)) {
        ambiguousNames.add(name);
        byName.delete(name);
      } else if (!ambiguousNames.has(name)) {
        byName.set(name, row);
      }
    }
    return { byComposite, byName, ambiguousNames };
  }

  function findGroupDropdownMonitor(index, name, multiplier) {
    const compositeKey = groupDropdownMonitorKey(name, multiplier);
    if (compositeKey && index?.byComposite instanceof Map && index.byComposite.has(compositeKey)) {
      return index.byComposite.get(compositeKey);
    }
    const normalizedName = normalizeGroupName(name);
    return normalizedName && index?.byName instanceof Map ? index.byName.get(normalizedName) || null : null;
  }

  function parseGroupOptionMultiplier(value) {
    const text = String(value || '');
    const match = text.match(/(?:×\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*x(?:\s*倍率)?)/i);
    if (!match) return null;
    const multiplier = Number(match[1] ?? match[2]);
    return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : null;
  }

  function formatGroupDropdownMonitor(row) {
    const latency = nonNegativeNumberOrNull(row?.firstTokenLatencyMs);
    const latencyValueText = row && latency !== null ? `${Math.round(latency)} ms` : '';
    const latencyText = row && latency !== null
      ? `首 Token ${latencyValueText}`
      : '首 Token 暂无数据';
    if (!row) return { statusText: '暂无监控', statusTone: 'unknown', latencyText, latencyValueText };
    if (row.enabled === false) return { statusText: '已停用', statusTone: 'disabled', latencyText, latencyValueText };
    if (row.available === true && Array.isArray(row.warningReasons) && row.warningReasons.length) {
      return { statusText: '可用 · 有警告', statusTone: 'warning', latencyText, latencyValueText };
    }
    if (row.available === true) return { statusText: '可用', statusTone: 'available', latencyText, latencyValueText };
    if (row.available === false) return { statusText: '不可用', statusTone: 'unavailable', latencyText, latencyValueText };
    return { statusText: '暂无监控', statusTone: 'unknown', latencyText, latencyValueText };
  }

  function getGroupDropdownToneClass(tone) {
    const safeTone = ['available', 'warning', 'unavailable', 'disabled', 'error'].includes(tone) ? tone : '';
    return safeTone ? `asg-key-group-badge-${safeTone}` : '';
  }

  function formatKeyOptionLabel(key, metric) {
    const name = String(key?.name || `Key ${key?.id ?? ''}`).trim();
    const groupName = String(key?.groupName || '未分组').trim();
    const multiplier = nonNegativeNumberOrNull(metric?.multiplier);
    const latencyMs = nonNegativeNumberOrNull(metric?.latencyMs);
    const multiplierText = multiplier === null ? '倍率暂无数据' : formatMultiplier(multiplier);
    const latencyText = latencyMs === null ? '首 Token 暂无数据' : `首 Token ${formatLatency(latencyMs)}`;
    return `${name} · ${groupName} · ${multiplierText} · ${latencyText}`;
  }

  function formatMultiplier(value) {
    const multiplier = Number(value);
    if (!Number.isFinite(multiplier) || multiplier < 0) return '';
    return `×${multiplier.toFixed(6).replace(/\.?0+$/, '')}`;
  }

  function getPageFeatures(pathname, loggedIn) {
    const path = String(pathname || '').split('?')[0];
    if (!loggedIn) return { panel: false, usage: false, keyGroups: false };
    return {
      panel: true,
      usage: path === '/usage' || path.startsWith('/usage/'),
      keyGroups: path === '/keys' || path.startsWith('/keys/'),
    };
  }

  function createStabilityState() {
    return { groupId: null, count: 0, stable: false };
  }

  function advanceStability(state, groupId, requiredChecks) {
    const required = Math.max(1, Math.round(Number(requiredChecks) || 1));
    const numericGroupId = Number.isInteger(Number(groupId)) ? Number(groupId) : null;
    if (numericGroupId === null) return createStabilityState();
    const sameGroup = state && state.groupId === numericGroupId;
    const count = sameGroup ? Number(state.count || 0) + 1 : 1;
    return { groupId: numericGroupId, count, stable: count >= required };
  }

  function canAutoSwitch(options) {
    return getAutoSwitchBlockReason(options) === '';
  }

  function getAutoSwitchBlockReason({ now, lastSwitchAt, currentGroupId, targetGroupId, stable, config, monitorStale, monitorFreshnessText }) {
    if (monitorStale) return `监控数据已过期（${monitorFreshnessText || '时间未知'}）`;
    if (!stable) return '推荐尚未稳定';
    if (targetGroupId == null) return '暂无推荐分组';
    if (currentGroupId === targetGroupId) return '当前密钥已经在推荐分组';
    const cooldown = getCooldownInfo(lastSwitchAt, normalizeConfig(config).cooldownMinutes, now);
    if (cooldown.active) return `切换冷却中（${cooldown.label}）`;
    return '';
  }

  function shouldLogTransition(previous, current, forced = false) {
    return forced || previous !== current;
  }

  function getSwitchBlockReason({ loading, allowWhileLoading, error, authError, monitorStale, monitorFreshnessText, winner, key, stability, requiredChecks }) {
    if (loading && !allowWhileLoading) return '正在检测';
    if (error) return String(error);
    if (authError) return String(authError);
    if (monitorStale) return `监控数据已过期（${monitorFreshnessText || '时间未知'}）`;
    if (!winner) return '暂无符合条件的推荐分组';
    if (!key) return '请先读取并选择目标密钥';
    if (!stability?.stable) return `推荐尚未稳定（${Number(stability?.count) || 0}/${requiredChecks} 次）`;
    if (key.groupId === winner.groupId) return '当前密钥已经在推荐分组';
    return '';
  }

  function projectKeys(keys) {
    return (Array.isArray(keys) ? keys : [])
      .filter((key) => key && key.id != null)
      .map((key) => ({
        id: key.id,
        name: String(key.name || `Key ${key.id}`),
        groupId: key.group_id == null ? null : Number(key.group_id),
        groupName: String(key.group?.name || key.group_name || '未分组'),
        status: String(key.status || ''),
      }));
  }

  function buildAuthHeaders(token) {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
  }

  function buildApiHeaders(path, token) {
    const headers = buildAuthHeaders(token);
    if (/^\/(?:auth\/me(?:\?|$)|keys(?:\/|\?|$)|groups\/(?:available|rates)(?:\?|$)|usage(?:\/|\?|$)|redeem(?:\/|\?|$)|subscriptions(?:\/|\?|$))/.test(path)) {
      headers['X-User-UI-Request'] = '1';
    }
    return headers;
  }

  function mergeKeyPages(pages) {
    const byId = new Map();
    for (const page of Array.isArray(pages) ? pages : []) {
      const items = Array.isArray(page)
        ? page
        : (Array.isArray(page?.items)
          ? page.items
          : (Array.isArray(page?.data?.items) ? page.data.items : (Array.isArray(page?.data) ? page.data : [])));
      for (const key of items) {
        if (key && key.id != null && !byId.has(key.id)) byId.set(key.id, key);
      }
    }
    return [...byId.values()];
  }

  function shouldRefreshKeys({ now = Date.now(), lastFetchedAt, keyCount, force = false, intervalMs = 5 * 60 * 1000 }) {
    const fetchedAt = Number(lastFetchedAt);
    return force === true
      || Number(keyCount) === 0
      || !Number.isFinite(fetchedAt)
      || fetchedAt <= 0
      || Number(now) - fetchedAt >= Math.max(0, Number(intervalMs) || 0);
  }

  function storageGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(STORAGE_PREFIX + key, fallback);
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_PREFIX + key, value);
        return;
      }
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage is optional; a failed write must not interrupt monitoring.
    }
  }

  function sanitizeLogText(value) {
    return String(value ?? '')
      .replace(/(Bearer\s+)[^\s,'"]+/gi, '$1[已隐藏]')
      .replace(/((?:auth[_-]?token|access[_-]?token|token)\s*[=:]\s*)[^\s,'"]+/gi, '$1[已隐藏]')
      .replace(/(?:sk-|key-)[^\s,'"]{8,}/gi, '[已隐藏]')
      .slice(0, 180);
  }

  function appendLogEntries(logs, entry, limit = 100) {
    const safeEntry = {
      at: Number(entry?.at) || Date.now(),
      scope: String(entry?.scope || 'general'),
      level: String(entry?.level || 'info'),
      message: sanitizeLogText(entry?.message),
    };
    return [safeEntry, ...(Array.isArray(logs) ? logs : [])]
      .slice(0, Math.max(1, Number(limit) || 100));
  }

  function formatLogLine(entry) {
    const time = new Date(Number(entry?.at) || Date.now()).toLocaleString();
    return `[${time}] ${entry?.level === 'error' ? '错误' : entry?.level === 'warn' ? '警告' : '信息'}：${sanitizeLogText(entry?.message)}`;
  }

  function readScopeLogs(scope) {
    return storageGet('runtime-logs', []).filter((entry) => entry?.scope === scope).slice(0, 30);
  }

  function writeRuntimeLog(scope, level, message) {
    const logs = appendLogEntries(storageGet('runtime-logs', []), { scope, level, message });
    storageSet('runtime-logs', logs);
    return logs;
  }

  function getAuthToken() {
    try {
      // Tampermonkey may expose page storage through the isolated world or
      // through unsafeWindow depending on its sandbox settings.
      const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      return pageWindow.localStorage.getItem('auth_token')
        || localStorage.getItem('auth_token')
        || '';
    } catch {
      return '';
    }
  }

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  async function apiRequest(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...buildApiHeaders(path, getAuthToken()),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    const response = await getPageWindow().fetch(`/api/v1${path}`, {
      credentials: 'include',
      ...options,
      headers,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload && (payload.detail || payload.message);
      const error = new Error(detail ? String(detail) : `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function fetchMonitorSummary() {
    return apiRequest('/public/monitor/summary');
  }

  async function fetchMonitorSeries() {
    return apiRequest('/public/monitor/series/6h');
  }

  async function fetchCurrentBalance() {
    return apiRequest('/auth/me?timezone=Asia%2FShanghai');
  }

  async function fetchAllKeys() {
    const pages = [];
    let page = 1;
    let totalPages = 1;
    do {
      const query = new URLSearchParams({ page: String(page), page_size: '100', sort_by: 'created_at', sort_order: 'desc' });
      const result = await apiRequest(`/keys?${query}`);
      pages.push(result);
      totalPages = Math.max(1, Number(result?.pages) || 1);
      page += 1;
    } while (page <= totalPages);
    return projectKeys(mergeKeyPages(pages));
  }

  async function updateKeyGroup(keyId, groupId) {
    return apiRequest(`/keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT',
      body: JSON.stringify({ group_id: Number(groupId) }),
    });
  }

  const STYLE = `
    #${ROOT_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;width:680px;height:min(620px,calc(100vh - 32px));max-width:calc(100vw - 32px);color:#172033;background:#fff;border:1px solid #d6dbe5;border-radius:8px;box-shadow:0 8px 30px rgba(16,24,40,.18);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
    #${ROOT_ID}[hidden]{display:none}
    #${ROOT_ID} *{box-sizing:border-box}
    #${ROOT_ID} .asg-head{display:flex;flex:none;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #e4e7ec}
    #${ROOT_ID} .asg-head strong{font-size:14px}
    #${ROOT_ID} button{font:inherit;cursor:pointer;border:1px solid #cfd5df;border-radius:6px;background:#fff;color:#172033;padding:5px 9px}
    #${ROOT_ID} button:hover:not(:disabled){background:#f3f5f8}
    #${ROOT_ID} button:disabled{cursor:not-allowed;opacity:.5}
    #${ROOT_ID} .asg-icon{border:0;padding:2px 5px;font-size:18px;line-height:1}
    #${ROOT_ID} .asg-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
    #${ROOT_ID} .asg-main-column,#${ROOT_ID} .asg-side-column{min-width:0;min-height:0;overflow:auto;padding:10px 12px}
    #${ROOT_ID} .asg-side-column{border-left:1px solid #e4e7ec;background:#fbfcfe}
    #${ROOT_ID} .asg-status-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
    #${ROOT_ID} .asg-status{min-width:0;color:#667085;font-size:12px}
    #${ROOT_ID} .asg-balance{flex:none;color:#15803d;font-size:12px;font-weight:600;text-align:right;white-space:nowrap}
    #${ROOT_ID} .asg-balance.asg-balance-error{color:#b54708;font-weight:500}
    #${ROOT_ID} .asg-recommend{padding:9px;background:#f4f8ff;border:1px solid #cfe0ff;border-radius:6px;margin:9px 0}
    #${ROOT_ID} .asg-recommend.asg-recommend-stale{background:#fff4f2;border-color:#fecdca}
    #${ROOT_ID} .asg-recommend strong{font-size:15px}
    #${ROOT_ID} .asg-muted{color:#667085}
    #${ROOT_ID} .asg-metrics{display:flex;flex-wrap:wrap;gap:6px 12px;color:#475467;font-size:12px;margin-top:4px}
    #${ROOT_ID} .asg-recommend-meta{margin-top:5px;color:#667085;font-size:11px;line-height:1.45;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-monitor-age{margin-top:4px;color:#15803d;font-size:11px}
    #${ROOT_ID} .asg-monitor-age.asg-stale{color:#b42318;font-weight:600}
    #${ROOT_ID} label{display:block;color:#475467;font-size:12px;margin:8px 0 4px}
    #${ROOT_ID} [data-availability-setting][hidden]{display:none !important}
    #${ROOT_ID} select,#${ROOT_ID} input[type=number],#${ROOT_ID} input[type=text]{width:100%;border:1px solid #cfd5df;border-radius:6px;padding:6px;background:#fff;color:#172033;font:inherit}
    #${ROOT_ID} .asg-key-details[hidden]{display:none}
    #${ROOT_ID} .asg-key-details{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px 10px;margin-top:5px;padding:6px 0 2px;border-bottom:1px solid #eef0f3}
    #${ROOT_ID} .asg-key-detail{min-width:0}
    #${ROOT_ID} .asg-key-detail span{display:block;color:#667085;font-size:10px}
    #${ROOT_ID} .asg-key-detail strong{display:block;margin-top:1px;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-key-metric{color:#15803d}
    #${ROOT_ID} .asg-actions{display:flex;gap:7px;margin-top:10px}
    #${ROOT_ID} .asg-actions button:last-child{flex:1;background:#1456d9;color:#fff;border-color:#1456d9}
    #${ROOT_ID} .asg-actions button:last-child:hover:not(:disabled){background:#0f46b6}
    #${ROOT_ID} .asg-auto{display:flex;align-items:center;gap:6px;margin-top:9px;color:#475467}
    #${ROOT_ID} .asg-auto input{margin:0}
    #${ROOT_ID} .asg-guide{margin-top:8px;color:#475467;font-size:12px}
    #${ROOT_ID} .asg-guide ol{margin:6px 0 0;padding-left:20px}
    #${ROOT_ID} details{margin-top:9px;border-top:1px solid #e4e7ec;padding-top:7px}
    #${ROOT_ID} summary{cursor:pointer;color:#475467}
    #${ROOT_ID} .asg-side-tabs{position:sticky;top:-10px;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px;margin:-10px -12px 0;padding:10px 12px 8px;background:#fbfcfe;border-bottom:1px solid #e4e7ec}
    #${ROOT_ID} .asg-side-tab{border-color:transparent;background:transparent;color:#667085;font-weight:600}
    #${ROOT_ID} .asg-side-tab[aria-selected=true]{border-color:#b8cff9;background:#eaf1ff;color:#1456d9}
    #${ROOT_ID} .asg-side-view[hidden]{display:none}
    #${ROOT_ID} .asg-settings-body{margin-top:7px}
    #${ROOT_ID} .asg-settings-section{padding:7px 0}
    #${ROOT_ID} .asg-settings-section+.asg-settings-section{border-top:1px solid #eef0f3}
    #${ROOT_ID} .asg-settings-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px;min-width:0}
    #${ROOT_ID} .asg-settings-title{flex:none;color:#344054;font-size:11px;font-weight:600}
    #${ROOT_ID} .asg-settings-inline-label{min-width:0;margin:0;color:#475467;font-size:12px;line-height:1.3;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-settings-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px 9px}
    #${ROOT_ID} .asg-settings-grid label{margin:0}
    #${ROOT_ID} .asg-settings-grid input[type=number],#${ROOT_ID} .asg-settings-grid input[type=text]{margin-top:3px}
    #${ROOT_ID} .asg-setting-wide{grid-column:1/-1}
    #${ROOT_ID} .asg-setting-compact{min-width:0}
    #${ROOT_ID} .asg-settings-grid .asg-auto{margin:1px 0 0}
    #${ROOT_ID} .asg-balance-setting{grid-column:1/-1}
    #${ROOT_ID} .asg-balance-preview,#${ROOT_ID} .asg-balance-reason,#${ROOT_ID} .asg-setting-preview{display:block;margin-top:4px;color:#15803d;font-size:11px;line-height:1.4;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-preview-pending{color:#b54708}
    #${ROOT_ID} .asg-save{width:100%;margin-top:5px;background:#1456d9;color:#fff;border-color:#1456d9;font-weight:600}
    #${ROOT_ID} .asg-save:hover:not(:disabled){background:#0f46b6}
    #${ROOT_ID} .asg-log-actions{display:flex;justify-content:flex-end;margin-top:7px}
    #${ROOT_ID} .asg-logs{margin:6px 0 0;padding:0;list-style:none;border-top:1px solid #eef0f3}
    #${ROOT_ID} .asg-logs li{padding:5px 0;border-bottom:1px solid #eef0f3;font-size:11px;overflow-wrap:anywhere}
    #${ROOT_ID} .asg-logs .asg-log-error{color:#b42318}
    #${ROOT_ID} .asg-list{margin:8px 0 0;padding:0;list-style:none;max-height:132px;overflow:auto;border-top:1px solid #eef0f3}
    #${ROOT_ID} .asg-list li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #eef0f3}
    #${ROOT_ID} .asg-list li span:last-child{text-align:right;color:#475467;white-space:nowrap}
    #${ROOT_ID} .asg-error{color:#b42318;background:#fff4f2;border-color:#fecdca}
    #${TOGGLE_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:42px;height:42px;padding:0;border:1px solid #1456d9;border-radius:50%;background:#1456d9;color:#fff;box-shadow:0 8px 24px rgba(16,24,40,.2);font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
    #${TOGGLE_ID}[hidden]{display:none}
    #${TOGGLE_ID}:hover{background:#0f46b6}
    @media (max-width:759px){
      #${ROOT_ID}{width:min(360px,calc(100vw - 32px))}
      #${ROOT_ID} .asg-body{
        display:flex;
        flex-direction:column;
        overflow:auto;
        -webkit-overflow-scrolling:touch;
      }
      #${ROOT_ID} .asg-main-column,
      #${ROOT_ID} .asg-side-column{
        flex:0 0 auto;
        min-height:auto;
        overflow:visible;
      }
      #${ROOT_ID} .asg-side-column{
        border-top:1px solid #e4e7ec;
        border-left:0;
      }
      #${ROOT_ID} .asg-side-tabs{
        position:static;
        top:auto;
        z-index:auto;
        margin:0;
        padding:0 0 8px;
      }
    }
  `;

  const USAGE_STYLE = `
    .asg-usage-multiplier{margin-inline-start:6px;color:#15803d;font-weight:600;white-space:nowrap}
  `;

  const KEY_GROUP_STYLE = `
    .asg-key-group-option .asg-key-group-row{align-items:center!important;gap:10px}
    .asg-key-group-main{display:flex!important;flex:1 1 auto;flex-direction:row!important;align-items:center!important;gap:7px;min-width:0}
    .asg-key-group-main>.groupOptionItemBadge{min-width:0}
    .groupOptionItemBadge.asg-key-group-badge-available{color:#15803d!important;background:#ecfdf3!important}
    .groupOptionItemBadge.asg-key-group-badge-warning{color:#b54708!important;background:#fffaeb!important}
    .groupOptionItemBadge.asg-key-group-badge-unavailable,.groupOptionItemBadge.asg-key-group-badge-error{color:#b42318!important;background:#fff1f0!important}
    .groupOptionItemBadge.asg-key-group-badge-disabled{color:#667085!important;background:#f2f4f7!important}
    .asg-key-group-rate-shell{flex:0 0 auto;min-width:max-content;padding-top:0!important}
    .asg-key-group-rate{display:flex!important;flex-direction:row!important;align-items:center!important;gap:8px;white-space:nowrap}
    .asg-key-group-status,.asg-key-group-latency{display:inline-flex;flex:0 0 auto;align-items:center;margin:0;font-size:11px;line-height:1.25;white-space:nowrap}
    .asg-key-group-status{font-weight:600}
    .asg-key-group-status::before{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:currentColor;content:"";vertical-align:1px}
    .asg-key-group-status-available{color:#15803d}
    .asg-key-group-status-warning{color:#b54708}
    .asg-key-group-status-unavailable,.asg-key-group-status-error{color:#b42318}
    .asg-key-group-status-disabled,.asg-key-group-status-unknown{color:#667085}
    .asg-key-group-latency{color:#667085;font-weight:500;text-align:right}
    .asg-key-group-latency-value{margin-left:3px;color:#15803d;font-weight:700}
    .dark .asg-key-group-status-available{color:#4ade80}
    .dark .asg-key-group-status-warning{color:#fbbf24}
    .dark .asg-key-group-status-unavailable,.dark .asg-key-group-status-error{color:#f87171}
    .dark .asg-key-group-status-disabled,.dark .asg-key-group-status-unknown,.dark .asg-key-group-latency{color:#98a2b3}
    .dark .asg-key-group-latency-value{color:#4ade80}
    .dark .groupOptionItemBadge.asg-key-group-badge-available{color:#4ade80!important;background:rgba(34,197,94,.12)!important}
    .dark .groupOptionItemBadge.asg-key-group-badge-warning{color:#fbbf24!important;background:rgba(245,158,11,.12)!important}
    .dark .groupOptionItemBadge.asg-key-group-badge-unavailable,.dark .groupOptionItemBadge.asg-key-group-badge-error{color:#f87171!important;background:rgba(239,68,68,.12)!important}
    .dark .groupOptionItemBadge.asg-key-group-badge-disabled{color:#98a2b3!important;background:rgba(152,162,179,.12)!important}
  `;

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
  }

  function formatLatency(value) {
    return Number.isFinite(value) ? `${Math.round(value)} ms` : '-';
  }

  class Controller {
    constructor(options = {}) {
      this.config = normalizeConfig(storageGet('config', DEFAULT_CONFIG));
      this.selectedKeyId = storageGet('selectedKeyId', null);
      this.lastSwitch = storageGet('lastSwitch', { at: null, keyId: null, groupId: null });
      this.stability = createStabilityState();
      this.rows = [];
      this.ranked = [];
      this.keys = [];
      this.loading = false;
      this.lastUpdated = null;
      this.error = '';
      this.authError = '';
      this.balance = null;
      this.balanceError = '';
      this.keyCount = null;
      this.minimized = storageGet('minimized', false) === true;
      this.sideTab = normalizePanelTab(storageGet('sideTab', 'settings'));
      this.timer = null;
      this.uiTimer = null;
      this.panel = null;
      this.toggleButton = null;
      this.active = false;
      this.monitorGeneratedAt = null;
      this.monitorFreshness = getMonitorFreshness(null, Date.now(), this.config.maxMonitorAgeSeconds);
      this.candidateDiagnostics = analyzeCandidates([], this.config);
      this.lastKeysFetchedAt = 0;
      this.lastDetectionLogSignature = null;
      this.lastMonitorStaleLogState = null;
      this.lastAuthLogSignature = '';
      this.lastErrorLogSignature = '';
      this.lastAutoSkipLogSignature = '';
      this.onAuthInvalid = typeof options.onAuthInvalid === 'function' ? options.onAuthInvalid : null;
    }

    start(registerMenu = true) {
      this.active = true;
      const existing = document.getElementById(ROOT_ID);
      if (existing?.dataset.version === SCRIPT_VERSION) return;
      existing?.remove();
      document.getElementById(TOGGLE_ID)?.remove();
      addStyle(STYLE);
      this.renderShell();
      this.bindEvents();
      if (registerMenu && typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('显示 AIHub 智能分组', () => this.setMinimized(false));
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), this.config.pollIntervalSeconds * 1000);
      this.uiTimer = window.setInterval(() => this.renderTimeSensitiveState(), 1000);
    }

    stop() {
      this.active = false;
      if (this.timer) window.clearInterval(this.timer);
      if (this.uiTimer) window.clearInterval(this.uiTimer);
      this.timer = null;
      this.uiTimer = null;
      this.panel?.remove();
      this.toggleButton?.remove();
      this.panel = null;
      this.toggleButton = null;
    }

    renderShell() {
      const panel = document.createElement('section');
      panel.id = ROOT_ID;
      panel.dataset.version = SCRIPT_VERSION;
      panel.innerHTML = `
        <div class="asg-head"><strong>AIHub 智能分组 v${SCRIPT_VERSION}</strong><button class="asg-icon" data-action="minimize" title="最小化">−</button></div>
        <div class="asg-body">
          <div class="asg-main-column">
            <div class="asg-status-row"><div class="asg-status" data-field="status">准备检测</div><div class="asg-balance" data-field="balance">余额读取中...</div></div>
            <label for="asg-mode-select">模式</label>
            <select id="asg-mode-select" data-field="mode"><option value="price">价格（最低价格）</option><option value="balance">平衡（倍率上限内首 Token 最快）</option><option value="speed">速度（最快首字）</option></select>
            <div class="asg-recommend" data-field="recommend"><div class="asg-muted">正在读取监控数据...</div></div>
            <label for="asg-key-select">目标密钥</label>
            <select id="asg-key-select" data-field="key"></select>
            <div class="asg-key-details" data-field="key-details" hidden>
              <div class="asg-key-detail"><span>密钥名</span><strong data-key-detail="name"></strong></div>
              <div class="asg-key-detail"><span>当前分组</span><strong data-key-detail="group"></strong></div>
              <div class="asg-key-detail"><span>倍率</span><strong class="asg-key-metric" data-key-detail="multiplier"></strong></div>
              <div class="asg-key-detail"><span>最新首 Token</span><strong class="asg-key-metric" data-key-detail="latency"></strong></div>
            </div>
            <div class="asg-actions"><button data-action="refresh">检测</button><button data-action="switch" disabled>切换到推荐分组</button></div>
            <label class="asg-auto"><input type="checkbox" data-field="auto"> 自动切换（默认关闭）</label>
            <details class="asg-guide"><summary>快速开始</summary><ol><li>选择价格、平衡或速度模式。</li><li>选择目标密钥并点击“检测”。</li><li>确认推荐分组后点击切换；自动切换可在设置中开启。</li></ol></details>
            <ul class="asg-list" data-field="list"></ul>
          </div>
          <aside class="asg-side-column" aria-label="设置与日志">
            <div class="asg-side-tabs" role="tablist" aria-label="面板工具">
              <button type="button" class="asg-side-tab" role="tab" id="asg-settings-tab" aria-controls="asg-settings-view" aria-selected="true" data-panel-tab="settings">设置</button>
              <button type="button" class="asg-side-tab" role="tab" id="asg-logs-tab" aria-controls="asg-logs-view" aria-selected="false" data-panel-tab="logs">日志</button>
            </div>
            <section class="asg-side-view" id="asg-settings-view" role="tabpanel" aria-labelledby="asg-settings-tab" data-panel-view="settings">
              <div class="asg-settings-body">
              <section class="asg-settings-section">
                <div class="asg-settings-head"><div class="asg-settings-title">可靠性筛选</div><label class="asg-settings-inline-label" for="asg-availability-mode-setting">可用性判断方式</label></div>
                <div class="asg-settings-grid">
                  <select id="asg-availability-mode-setting" data-setting="availabilityMode"><option value="percent">按可用率（百分比）</option><option value="successes">按成功监控点数</option><option value="consecutive">按连续成功点数</option></select>
                  <label class="asg-setting-compact asg-auto"><input type="checkbox" data-setting="requireNoWarnings"> 排除监控警告</label>
                  <label class="asg-setting-wide" data-availability-setting="percent" title="可自行修改，0.1 表示 10%">最近10分钟最低可用率（默认10%）<input type="number" min="0" max="1" step="0.01" data-setting="minSuccess10m"></label>
                  <label class="asg-setting-wide" data-availability-setting="successes">最近10分钟至少成功监控点数<input type="number" min="1" max="60" step="1" data-setting="minSuccessPoints10m"></label>
                  <label class="asg-setting-wide" data-availability-setting="consecutive">连续成功监控点数<input type="number" min="1" max="60" step="1" data-setting="minConsecutiveSuccesses10m"></label>
                  <label class="asg-setting-wide" title="名称包含任一关键词的分组不会参与推荐或切换">排除分组关键词（使用 | 分隔）<input type="text" data-setting="excludedGroupKeywords" placeholder="例如 free|unstable"></label>
                  <span class="asg-setting-preview asg-setting-wide" data-field="excluded-preview" aria-live="polite"></span>
                </div>
              </section>
              <section class="asg-settings-section">
                <div class="asg-settings-title">检测与切换</div>
                <div class="asg-settings-grid">
                  <label>连续通过次数<input type="number" min="1" max="5" step="1" data-setting="consecutiveChecks"></label>
                  <label>检测间隔（秒）<input type="number" min="10" max="3600" step="1" data-setting="pollIntervalSeconds"></label>
                  <label class="asg-setting-wide">切换冷却（分钟）<input type="number" min="0" max="1440" step="0.1" data-setting="cooldownMinutes"><span class="asg-setting-preview" data-field="cooldown-preview" aria-live="polite"></span></label>
                </div>
              </section>
              <section class="asg-settings-section">
                <div class="asg-settings-head"><div class="asg-settings-title">平衡策略</div><label class="asg-settings-inline-label" for="asg-balance-max-setting">允许切换的最高倍率</label></div>
                <div class="asg-settings-grid">
                  <label class="asg-balance-setting"><input id="asg-balance-max-setting" type="number" min="0" max="1000" step="0.001" data-setting="balanceMaxPrice" aria-label="允许切换的最高倍率"><span class="asg-balance-preview" data-field="balance-preview" aria-live="polite"></span></label>
                </div>
              </section>
              <button class="asg-save" data-action="save-settings">保存设置</button>
              </div>
            </section>
            <section class="asg-side-view" id="asg-logs-view" role="tabpanel" aria-labelledby="asg-logs-tab" data-panel-view="logs" hidden>
              <div class="asg-log-actions"><button data-action="clear-logs">清空日志</button></div>
              <ul class="asg-logs" data-field="logs"></ul>
            </section>
          </aside>
        </div>`;
      document.body.appendChild(panel);
      this.panel = panel;
      const toggle = document.createElement('button');
      toggle.id = TOGGLE_ID;
      toggle.type = 'button';
      toggle.textContent = 'AI';
      toggle.title = '打开 AIHub 智能分组';
      toggle.setAttribute('aria-label', '打开 AIHub 智能分组');
      document.body.appendChild(toggle);
      this.toggleButton = toggle;
      this.setSideTab(this.sideTab);
      this.syncSettingsInputs();
      this.setMinimized(this.minimized);
    }

    bindEvents() {
      this.panel.addEventListener('click', (event) => {
        const panelTab = event.target.closest('[data-panel-tab]')?.dataset.panelTab;
        if (panelTab) this.setSideTab(panelTab);
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'minimize') this.setMinimized(true);
        if (action === 'refresh') this.refresh(true);
        if (action === 'switch') this.switchToRecommendation(false);
        if (action === 'save-settings') this.saveSettings();
        if (action === 'clear-logs') this.clearLogs();
      });
      this.panel.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const tabs = [...this.panel.querySelectorAll('[data-panel-tab]')];
        const currentIndex = tabs.indexOf(document.activeElement);
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
        this.setSideTab(nextTab.dataset.panelTab);
        nextTab.focus();
      });
      this.toggleButton.addEventListener('click', () => this.setMinimized(false));
      this.panel.querySelector('[data-field="key"]').addEventListener('change', (event) => {
        this.selectedKeyId = event.target.value || null;
        storageSet('selectedKeyId', this.selectedKeyId);
        this.renderSelectedKeyDetails();
        this.renderActionState();
      });
      this.panel.querySelector('[data-field="mode"]').addEventListener('change', (event) => {
        this.config.mode = normalizeGroupMode(event.target.value);
        storageSet('config', this.config);
        this.log('info', `模式改为${GROUP_MODE_LABELS[this.config.mode]}`);
        this.refresh();
      });
      this.panel.querySelector('[data-field="auto"]').addEventListener('change', (event) => {
        if (event.target.checked && !window.confirm('自动切换会在检测通过后修改选中 API 密钥的分组，是否启用？')) {
          event.target.checked = false;
          return;
        }
        this.config.autoSwitch = event.target.checked;
        storageSet('config', this.config);
        this.log('info', event.target.checked ? '已开启自动切换' : '已关闭自动切换');
        this.refresh();
      });
      this.panel.addEventListener('input', (event) => {
        if (event.target.matches('[data-setting]')) this.renderSettingsPreviews();
      });
      this.panel.addEventListener('change', (event) => {
        if (event.target.matches('[data-setting="availabilityMode"]')) {
          this.syncAvailabilityInputs();
          this.renderSettingsPreviews();
        }
      });
    }

    setMinimized(value) {
      this.minimized = value === true;
      if (this.panel) this.panel.hidden = this.minimized;
      if (this.toggleButton) this.toggleButton.hidden = !this.minimized;
      storageSet('minimized', this.minimized);
    }

    setSideTab(value) {
      this.sideTab = normalizePanelTab(value);
      storageSet('sideTab', this.sideTab);
      for (const tab of this.panel?.querySelectorAll('[data-panel-tab]') || []) {
        const selected = tab.dataset.panelTab === this.sideTab;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const view of this.panel?.querySelectorAll('[data-panel-view]') || []) {
        view.hidden = view.dataset.panelView !== this.sideTab;
      }
    }

    syncSettingsInputs() {
      for (const input of this.panel.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = this.config[key] === true;
        else input.value = this.config[key];
      }
      this.panel.querySelector('[data-field="auto"]').checked = this.config.autoSwitch;
      this.panel.querySelector('[data-field="mode"]').value = this.config.mode;
      this.syncAvailabilityInputs();
      this.renderSettingsPreviews();
    }

    syncAvailabilityInputs() {
      const mode = normalizeAvailabilityMode(this.panel?.querySelector('[data-setting="availabilityMode"]')?.value);
      for (const field of this.panel?.querySelectorAll('[data-availability-setting]') || []) {
        field.hidden = field.dataset.availabilitySetting !== mode;
      }
    }

    readDraftConfig() {
      const draft = { ...this.config };
      for (const input of this.panel?.querySelectorAll('[data-setting]') || []) {
        draft[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
      }
      return normalizeConfig(draft);
    }

    renderSettingsPreviews() {
      this.renderBalancePreview();
      this.renderExcludedPreview();
      this.renderCooldownPreview();
    }

    renderBalancePreview() {
      const preview = this.panel?.querySelector('[data-field="balance-preview"]');
      const maxPriceInput = this.panel?.querySelector('[data-setting="balanceMaxPrice"]');
      if (!preview || !maxPriceInput) return;
      const rawMaxPrice = maxPriceInput.value.trim();
      if (rawMaxPrice === '' || !maxPriceInput.checkValidity()) {
        preview.textContent = '请输入 0–1000 之间的倍率';
        preview.classList.add('asg-preview-pending');
        return;
      }
      const normalizedDraft = this.readDraftConfig();
      const candidateCount = getEligibleCandidates(this.rows, normalizedDraft)
        .filter((candidate) => candidate.price <= normalizedDraft.balanceMaxPrice).length;
      const hasUnsavedFilter = normalizedDraft.balanceMaxPrice !== this.config.balanceMaxPrice
        || normalizedDraft.minSuccess10m !== this.config.minSuccess10m
        || normalizedDraft.availabilityMode !== this.config.availabilityMode
        || normalizedDraft.minSuccessPoints10m !== this.config.minSuccessPoints10m
        || normalizedDraft.minConsecutiveSuccesses10m !== this.config.minConsecutiveSuccesses10m
        || normalizedDraft.requireNoWarnings !== this.config.requireNoWarnings
        || normalizedDraft.excludedGroupKeywords !== this.config.excludedGroupKeywords;
      const suffix = hasUnsavedFilter ? ' · 未保存' : '';
      const limit = formatMultiplier(normalizedDraft.balanceMaxPrice);
      if (!this.lastUpdated) {
        preview.textContent = `最高倍率 ${limit} · 检测后显示符合分组${suffix}`;
      } else if (candidateCount === 0) {
        preview.textContent = `最高倍率 ${limit} · 当前没有符合条件的分组${suffix}`;
      } else {
        preview.textContent = `只考虑倍率 ≤ ${limit} · ${candidateCount} 个分组可选 · 将选首 Token 最快${suffix}`;
      }
      preview.classList.toggle('asg-preview-pending', hasUnsavedFilter);
    }

    renderExcludedPreview() {
      const preview = this.panel?.querySelector('[data-field="excluded-preview"]');
      const input = this.panel?.querySelector('[data-setting="excludedGroupKeywords"]');
      if (!preview || !input) return;
      const info = getExcludedGroupInfo(this.rows, input.value);
      const normalized = info.keywords.join('|');
      const unsaved = normalized !== this.config.excludedGroupKeywords;
      const suffix = unsaved ? ' · 未保存' : '';
      if (!info.keywords.length) {
        preview.textContent = `未设置排除关键词${suffix}`;
      } else if (!this.lastUpdated) {
        preview.textContent = `${info.keywords.length} 个关键词 · 检测后显示匹配分组${suffix}`;
      } else if (!info.matches.length) {
        preview.textContent = `未匹配到分组${suffix}`;
      } else {
        const names = info.matches.slice(0, 3).map((match) => match.name).join('、');
        const more = info.matches.length > 3 ? ` 等 ${info.matches.length} 个` : '';
        preview.textContent = `将排除 ${info.matches.length} 个：${names}${more}${suffix}`;
      }
      preview.classList.toggle('asg-preview-pending', unsaved);
    }

    renderCooldownPreview() {
      const preview = this.panel?.querySelector('[data-field="cooldown-preview"]');
      const input = this.panel?.querySelector('[data-setting="cooldownMinutes"]');
      if (!preview || !input) return;
      if (input.value.trim() === '' || !input.checkValidity()) {
        preview.textContent = '请输入 0–1440 之间的分钟数';
        preview.classList.add('asg-preview-pending');
        return;
      }
      const minutes = normalizeConfig({ ...this.config, cooldownMinutes: input.value }).cooldownMinutes;
      const unsaved = minutes !== this.config.cooldownMinutes;
      const cooldown = getCooldownInfo(Number(this.lastSwitch.at), minutes);
      preview.textContent = `${minutes} 分钟 = ${formatRemainingTime(minutes * 60 * 1000)}${cooldown.active ? ` · 当前${cooldown.label}` : ''}${unsaved ? ' · 未保存' : ''}`;
      preview.classList.toggle('asg-preview-pending', unsaved);
    }

    saveSettings() {
      const next = {};
      for (const input of this.panel.querySelectorAll('[data-setting]')) {
        next[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
      }
      next.autoSwitch = this.config.autoSwitch;
      next.mode = this.config.mode;
      this.config = normalizeConfig(next);
      storageSet('config', this.config);
      this.syncSettingsInputs();
      if (this.timer) window.clearInterval(this.timer);
      this.timer = window.setInterval(() => this.refresh(), this.config.pollIntervalSeconds * 1000);
      this.setStatus('设置已保存');
      this.log('info', '设置已保存');
      this.refresh(true);
    }

    log(level, message) {
      writeRuntimeLog('aihub', level, message);
      this.renderLogs();
    }

    clearLogs() {
      storageSet('runtime-logs', storageGet('runtime-logs', []).filter((entry) => entry?.scope !== 'aihub'));
      this.renderLogs();
    }

    renderLogs() {
      const list = this.panel?.querySelector('[data-field="logs"]');
      if (!list) return;
      list.replaceChildren();
      const logs = readScopeLogs('aihub');
      if (!logs.length) {
        const empty = document.createElement('li');
        empty.className = 'asg-muted';
        empty.textContent = '暂无日志';
        list.appendChild(empty);
        return;
      }
      for (const entry of logs) {
        const item = document.createElement('li');
        item.className = `asg-log-${entry.level}`;
        item.textContent = formatLogLine(entry);
        list.appendChild(item);
      }
    }

    async refresh(forceLog = false) {
      if (this.loading) return;
      this.loading = true;
      this.authError = '';
      this.setStatus('检测中...');
      this.renderActionState();
      try {
        const [summary, series, balanceResult] = await Promise.all([
          fetchMonitorSummary(),
          fetchMonitorSeries(),
          fetchCurrentBalance().then((payload) => ({ payload })).catch((error) => ({ error })),
        ]);
        if (!this.active) return;
        if (balanceResult.error) {
          this.balanceError = balanceResult.error instanceof Error ? balanceResult.error.message : '余额读取失败';
        } else {
          this.balance = getBalanceAmount(balanceResult.payload);
          this.balanceError = this.balance === null ? '余额数据格式异常' : '';
        }
        let keys = null;
        if (shouldRefreshKeys({ now: Date.now(), lastFetchedAt: this.lastKeysFetchedAt, keyCount: this.keys.length, force: forceLog })) {
          try {
            keys = await fetchAllKeys();
            if (!this.active) return;
            this.lastKeysFetchedAt = Date.now();
          } catch (error) {
            if (!this.active) return;
            if (error?.status === 401 && this.onAuthInvalid) {
              this.onAuthInvalid();
              if (!this.active) return;
            }
            this.authError = error?.status === 401
              ? (getAuthToken() ? '密钥接口返回 401：当前登录已失效，请重新登录后刷新' : '未找到页面登录令牌，请在此 Chrome 配置中重新登录后刷新')
              : (error instanceof Error ? `密钥读取失败：${error.message}` : '密钥读取失败');
          }
        }
        if (this.authError && shouldLogTransition(this.lastAuthLogSignature, this.authError, forceLog)) {
          this.log('error', this.authError);
        } else if (!this.authError && this.lastAuthLogSignature) {
          this.log('info', '密钥读取已恢复');
        }
        this.lastAuthLogSignature = this.authError;
        this.rows = attachRecentAvailability(summary?.apis, series);
        this.monitorGeneratedAt = getLatestMonitorSampleAt(series) || series?.generatedAt || summary?.generatedAt || null;
        this.updateMonitorFreshness();
        this.recordMonitorFreshnessState();
        this.candidateDiagnostics = analyzeCandidates(this.rows, this.config);
        this.ranked = rankCandidates(this.rows, this.config);
        const winner = this.ranked[0] || null;
        this.stability = this.monitorFreshness.stale
          ? createStabilityState()
          : advanceStability(this.stability, winner?.groupId ?? null, this.config.consecutiveChecks);
        if (keys) {
          this.keys = keys;
          this.keyCount = keys.length;
          if (!this.keys.some((key) => String(key.id) === String(this.selectedKeyId))) {
            this.selectedKeyId = this.keys.length === 1 ? this.keys[0].id : null;
            storageSet('selectedKeyId', this.selectedKeyId);
          }
        }
        this.lastUpdated = new Date();
        this.error = '';
        this.renderData();
        const detectionSignature = `${this.config.mode}:${winner?.groupId ?? 'none'}`;
        if (shouldLogTransition(this.lastDetectionLogSignature, detectionSignature, forceLog)) {
          this.log('info', `检测完成，推荐${winner?.name || '暂无分组'}`);
        }
        this.lastDetectionLogSignature = detectionSignature;
        if (this.lastErrorLogSignature) this.log('info', '监控检测已恢复');
        this.lastErrorLogSignature = '';
        if (this.config.autoSwitch) await this.switchToRecommendation(true);
      } catch (error) {
        if (!this.active) return;
        this.error = error instanceof Error ? error.message : '检测失败';
        if (shouldLogTransition(this.lastErrorLogSignature, this.error, forceLog)) this.log('error', this.error);
        this.lastErrorLogSignature = this.error;
        this.setStatus(this.error, true);
        this.renderActionState();
      } finally {
        this.loading = false;
        if (this.active) this.renderActionState();
      }
    }

    updateMonitorFreshness() {
      this.monitorFreshness = getMonitorFreshness(this.monitorGeneratedAt, Date.now(), this.config.maxMonitorAgeSeconds);
      return this.monitorFreshness;
    }

    renderTimeSensitiveState() {
      if (!this.active || !this.panel) return;
      const wasStale = this.monitorFreshness.stale;
      this.updateMonitorFreshness();
      if (!wasStale && this.monitorFreshness.stale) this.stability = createStabilityState();
      this.recordMonitorFreshnessState();
      this.panel.querySelector('[data-field="recommend"]')?.classList.toggle('asg-recommend-stale', this.monitorFreshness.stale);
      const node = this.panel.querySelector('[data-field="monitor-freshness"]');
      if (node) {
        node.textContent = this.monitorFreshness.stale
          ? `监控数据已过期（${this.monitorFreshness.label}），切换已暂停`
          : `数据更新于 ${this.monitorFreshness.label}`;
        node.classList.toggle('asg-stale', this.monitorFreshness.stale);
      }
      this.renderCooldownPreview();
      this.renderActionState();
    }

    recordMonitorFreshnessState() {
      if (!this.monitorGeneratedAt || this.lastMonitorStaleLogState === this.monitorFreshness.stale) return;
      if (this.monitorFreshness.stale) {
        this.log('error', `监控数据已超过 10 分钟未更新（${this.monitorFreshness.label}），已暂停切换`);
      } else if (this.lastMonitorStaleLogState === true) {
        this.log('info', '监控数据已恢复，切换保护解除');
      }
      this.lastMonitorStaleLogState = this.monitorFreshness.stale;
    }

    selectedKey() {
      return this.keys.find((key) => String(key.id) === String(this.selectedKeyId)) || null;
    }

    async switchToRecommendation(fromAuto) {
      const winner = this.ranked[0];
      const key = this.selectedKey();
      const blockReason = getSwitchBlockReason({
        loading: this.loading,
        allowWhileLoading: fromAuto,
        error: this.error,
        authError: this.authError,
        monitorStale: this.monitorFreshness.stale,
        monitorFreshnessText: this.monitorFreshness.label,
        winner,
        key,
        stability: this.stability,
        requiredChecks: this.config.consecutiveChecks,
      });
      if (blockReason) {
        if (fromAuto) {
          if (shouldLogTransition(this.lastAutoSkipLogSignature, blockReason)) this.log('info', `自动切换跳过：${blockReason}`);
          this.lastAutoSkipLogSignature = blockReason;
        } else {
          this.setStatus(blockReason, Boolean(this.error || this.authError));
        }
        return false;
      }
      const now = Date.now();
      if (fromAuto && !canAutoSwitch({
        now,
        lastSwitchAt: Number(this.lastSwitch.at),
        currentGroupId: key.groupId,
        targetGroupId: winner.groupId,
        stable: this.stability.stable,
        config: this.config,
        monitorStale: this.monitorFreshness.stale,
        monitorFreshnessText: this.monitorFreshness.label,
      })) {
        const reason = getAutoSwitchBlockReason({
          now,
          lastSwitchAt: Number(this.lastSwitch.at),
          currentGroupId: key.groupId,
          targetGroupId: winner.groupId,
          stable: this.stability.stable,
          config: this.config,
          monitorStale: this.monitorFreshness.stale,
          monitorFreshnessText: this.monitorFreshness.label,
        });
        if (shouldLogTransition(this.lastAutoSkipLogSignature, reason)) this.log('info', `自动切换跳过：${reason}`);
        this.lastAutoSkipLogSignature = reason;
        return false;
      }
      if (!fromAuto && !window.confirm(`将密钥“${key.name}”切换到 ${winner.name}（${winner.price}x），是否继续？`)) return false;
      try {
        await updateKeyGroup(key.id, winner.groupId);
        if (!this.active) return false;
        key.groupId = winner.groupId;
        key.groupName = winner.name;
        this.lastKeysFetchedAt = 0;
        this.lastSwitch = { at: Date.now(), keyId: key.id, groupId: winner.groupId };
        this.lastAutoSkipLogSignature = '';
        storageSet('lastSwitch', this.lastSwitch);
        this.setStatus(`已切换到 ${winner.name}`);
        this.log('info', `已切换到${winner.name}`);
        this.renderData();
        return true;
      } catch (error) {
        if (!this.active) return false;
        this.setStatus(error instanceof Error ? error.message : '切换失败', true);
        this.log('error', error instanceof Error ? error.message : '切换失败');
        return false;
      }
    }

    setStatus(text, error = false) {
      const node = this.panel?.querySelector('[data-field="status"]');
      if (node) {
        node.textContent = text;
        node.classList.toggle('asg-error', error);
      }
    }

    renderData() {
      const winner = this.ranked[0];
      const recommend = this.panel.querySelector('[data-field="recommend"]');
      recommend.classList.toggle('asg-recommend-stale', this.monitorFreshness.stale);
      recommend.replaceChildren();
      if (!winner) {
        const empty = document.createElement('div');
        empty.className = 'asg-muted';
        empty.textContent = this.config.mode === 'balance'
          ? '没有符合当前可靠性和倍率上限的分组'
          : '没有符合当前可靠性条件的分组';
        recommend.appendChild(empty);
      } else {
        const title = document.createElement('strong');
        title.textContent = `${GROUP_MODE_LABELS[this.config.mode]}模式 · ${winner.name} · ${winner.price}x`;
        const metrics = document.createElement('div');
        metrics.className = 'asg-metrics';
        const availabilityText = this.config.availabilityMode === 'successes'
          ? `成功 ${winner.recentSuccessCount || 0}/${winner.recentSampleCount || 0} 点`
          : this.config.availabilityMode === 'consecutive'
            ? `连续成功 ${winner.recentConsecutiveSuccessCount || 0} 点`
            : `可用率 ${formatPercent(winner.success10m)}`;
        metrics.textContent = `10m ${availabilityText} · ${winner.recentSampleCount}次探测 · 首Token ${formatLatency(winner.latency)}${this.stability.stable ? ' · 已稳定' : ` · ${this.stability.count}/${this.config.consecutiveChecks} 次`}`;
        recommend.append(title, metrics);
        if (this.config.mode === 'balance') {
          const reason = document.createElement('div');
          reason.className = 'asg-balance-reason';
          reason.textContent = `倍率上限 ${formatMultiplier(this.config.balanceMaxPrice)} · 范围内首 Token 最快`;
          recommend.appendChild(reason);
        }
      }
      const diagnostics = this.candidateDiagnostics?.counts || {};
      const diagnostic = document.createElement('div');
      diagnostic.className = 'asg-recommend-meta';
      const overLimit = this.config.mode === 'balance' ? Math.max(0, Number(diagnostics.eligible || 0) - this.ranked.length) : 0;
      diagnostic.textContent = `参与比较 ${this.ranked.length} · 排除关键词 ${diagnostics.keywords || 0} · 不可用 ${diagnostics.unavailable || 0} · 可用率不足 ${diagnostics.lowSuccess || 0} · 监控警告 ${diagnostics.warnings || 0}${overLimit ? ` · 超过倍率上限 ${overLimit}` : ''}`;
      recommend.appendChild(diagnostic);
      const freshness = document.createElement('div');
      freshness.className = `asg-monitor-age${this.monitorFreshness.stale ? ' asg-stale' : ''}`;
      freshness.dataset.field = 'monitor-freshness';
      freshness.textContent = this.monitorFreshness.stale
        ? `监控数据已过期（${this.monitorFreshness.label}），切换已暂停`
        : `数据更新于 ${this.monitorFreshness.label}`;
      recommend.appendChild(freshness);
      this.renderBalance();
      const keyInfo = this.authError || (this.keyCount !== null ? `已读取 ${this.keyCount} 个密钥` : '');
      this.setStatus(this.error || keyInfo || (this.lastUpdated ? `最近检测：${this.lastUpdated.toLocaleTimeString()}` : '准备检测'), Boolean(this.error || this.authError));
      this.renderKeys();
      this.renderCandidates();
      this.renderLogs();
      this.renderActionState();
      this.renderSettingsPreviews();
    }

    renderBalance() {
      const node = this.panel?.querySelector('[data-field="balance"]');
      if (!node) return;
      node.classList.toggle('asg-balance-error', Boolean(this.balanceError));
      node.textContent = this.balanceError ? '余额暂不可用' : `余额 ${formatBalance(this.balance)}`;
      node.title = this.balanceError ? this.balanceError : '每次检测刷新当前余额';
    }

    renderKeys() {
      const select = this.panel.querySelector('[data-field="key"]');
      const metricMap = buildGroupMetricMap(this.rows);
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = this.keys.length
        ? '选择要切换的密钥'
        : (this.authError || (this.keyCount !== null ? `接口返回 ${this.keyCount} 个密钥` : '未读取到密钥'));
      select.appendChild(placeholder);
      for (const key of this.keys) {
        const option = document.createElement('option');
        option.value = key.id;
        option.textContent = formatKeyOptionLabel(key, metricMap.get(key.groupId));
        option.selected = String(key.id) === String(this.selectedKeyId);
        select.appendChild(option);
      }
      select.disabled = this.keys.length === 0;
      this.renderSelectedKeyDetails(metricMap);
    }

    renderSelectedKeyDetails(metricMap = buildGroupMetricMap(this.rows)) {
      const details = this.panel?.querySelector('[data-field="key-details"]');
      if (!details) return;
      const key = this.selectedKey();
      details.hidden = !key;
      if (!key) return;
      const metric = metricMap.get(key.groupId);
      const multiplier = nonNegativeNumberOrNull(metric?.multiplier);
      const latencyMs = nonNegativeNumberOrNull(metric?.latencyMs);
      details.querySelector('[data-key-detail="name"]').textContent = key.name;
      details.querySelector('[data-key-detail="group"]').textContent = key.groupName;
      details.querySelector('[data-key-detail="multiplier"]').textContent = multiplier === null ? '暂无数据' : formatMultiplier(multiplier);
      details.querySelector('[data-key-detail="latency"]').textContent = latencyMs === null ? '暂无数据' : formatLatency(latencyMs);
    }

    renderCandidates() {
      const list = this.panel.querySelector('[data-field="list"]');
      list.replaceChildren();
      for (const candidate of this.ranked.slice(0, 5)) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = candidate.name;
        const metrics = document.createElement('span');
        metrics.textContent = `${candidate.price}x · 10m ${formatPercent(candidate.success10m)}`;
        item.append(name, metrics);
        list.appendChild(item);
      }
    }

    renderActionState() {
      const button = this.panel.querySelector('[data-action="switch"]');
      const winner = this.ranked[0];
      const key = this.selectedKey();
      const reason = getSwitchBlockReason({
        loading: this.loading,
        error: this.error,
        authError: this.authError,
        monitorStale: this.monitorFreshness.stale,
        monitorFreshnessText: this.monitorFreshness.label,
        winner,
        key,
        stability: this.stability,
        requiredChecks: this.config.consecutiveChecks,
      });
      button.disabled = Boolean(reason);
      button.title = reason || `切换到 ${winner.name}`;
    }
  }

  class KeyGroupDropdownEnhancer {
    constructor() {
      this.monitorIndex = buildGroupDropdownMonitorIndex([]);
      this.observer = null;
      this.renderTimer = null;
      this.refreshTimer = null;
      this.renderQueued = false;
      this.loading = false;
      this.active = false;
      this.hasMonitorData = false;
      this.loadFailed = false;
      this.lastAttemptAt = 0;
      this.lastErrorSignature = '';
    }

    start() {
      this.active = true;
      addStyle(KEY_GROUP_STYLE);
      this.observer = new MutationObserver(() => this.queueRender());
      this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      this.queueRender();
      this.refreshTimer = window.setInterval(() => {
        if (this.findMenus().length && Date.now() - this.lastAttemptAt >= 60_000) this.refresh();
      }, 60_000);
    }

    stop() {
      this.active = false;
      this.observer?.disconnect();
      this.observer = null;
      if (this.renderTimer) window.clearTimeout(this.renderTimer);
      if (this.refreshTimer) window.clearInterval(this.refreshTimer);
      this.renderTimer = null;
      this.refreshTimer = null;
      document.querySelectorAll('.asg-key-group-status,.asg-key-group-latency').forEach((node) => node.remove());
      document.querySelectorAll('.asg-key-group-option').forEach((button) => {
        button.classList.remove('asg-key-group-option');
        const badge = button.querySelector('.groupOptionItemBadge');
        if (badge?.dataset.asgToneClass) {
          badge.classList.remove(badge.dataset.asgToneClass);
          delete badge.dataset.asgToneClass;
        }
        button.querySelector('.asg-key-group-row')?.classList.remove('asg-key-group-row');
        button.querySelector('.asg-key-group-main')?.classList.remove('asg-key-group-main');
        button.querySelector('.asg-key-group-rate-shell')?.classList.remove('asg-key-group-rate-shell');
        button.querySelector('.asg-key-group-rate')?.classList.remove('asg-key-group-rate');
      });
    }

    findMenus() {
      return [...document.querySelectorAll('input[placeholder="搜索分组..."]')]
        .map((input) => {
          const searchArea = input.parentElement?.parentElement;
          const menu = searchArea?.parentElement;
          const optionList = searchArea?.nextElementSibling;
          return menu && optionList && menu.contains(optionList) ? { menu, optionList } : null;
        })
        .filter(Boolean);
    }

    queueRender() {
      if (!this.active || this.renderQueued) return;
      this.renderQueued = true;
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        this.renderQueued = false;
        this.render();
      }, 0);
    }

    async refresh() {
      if (!this.active || this.loading || Date.now() - this.lastAttemptAt < 60_000) return;
      this.loading = true;
      this.loadFailed = false;
      this.lastAttemptAt = Date.now();
      this.render();
      try {
        const summary = await fetchMonitorSummary();
        if (!this.active) return;
        this.monitorIndex = buildGroupDropdownMonitorIndex(summary?.apis);
        this.hasMonitorData = true;
        if (this.lastErrorSignature) writeRuntimeLog('aihub', 'info', '密钥分组监控读取已恢复');
        this.lastErrorSignature = '';
      } catch (error) {
        if (!this.active) return;
        this.loadFailed = !this.hasMonitorData;
        const message = error instanceof Error ? error.message : '未知错误';
        if (message !== this.lastErrorSignature) writeRuntimeLog('aihub', 'error', `密钥分组监控读取失败：${message}`);
        this.lastErrorSignature = message;
      } finally {
        this.loading = false;
        if (this.active) this.render();
      }
    }

    render() {
      if (!this.active) return;
      const menus = this.findMenus();
      if (!menus.length) return;
      if (!this.hasMonitorData && !this.loading && Date.now() - this.lastAttemptAt >= 60_000) this.refresh();
      for (const { optionList } of menus) {
        for (const button of optionList.querySelectorAll('button')) this.renderOption(button);
      }
    }

    renderOption(button) {
      const badge = button.querySelector('.groupOptionItemBadge');
      const nameNode = badge?.querySelector('.truncate');
      const content = button.firstElementChild;
      const leftColumn = badge?.parentElement;
      const rightShell = content?.lastElementChild;
      const rightColumn = rightShell?.firstElementChild || rightShell;
      const multiplierNode = rightColumn?.querySelector('span');
      const name = nameNode?.textContent?.trim();
      if (!name || !leftColumn || !rightColumn || !multiplierNode) return;

      button.classList.add('asg-key-group-option');
      content.classList.add('asg-key-group-row');
      leftColumn.classList.add('asg-key-group-main');
      rightShell?.classList.add('asg-key-group-rate-shell');
      rightColumn.classList.add('asg-key-group-rate');

      let info;
      if (this.loadFailed) {
        info = { statusText: '监控读取失败', statusTone: 'error', latencyText: '首 Token 暂无数据', latencyValueText: '' };
      } else if (!this.hasMonitorData) {
        info = { statusText: '监控读取中', statusTone: 'unknown', latencyText: '首 Token --', latencyValueText: '' };
      } else {
        const multiplier = parseGroupOptionMultiplier(multiplierNode.textContent);
        info = formatGroupDropdownMonitor(findGroupDropdownMonitor(this.monitorIndex, name, multiplier));
      }

      const badgeToneClass = getGroupDropdownToneClass(info.statusTone);
      const currentBadgeToneClass = badge.dataset.asgToneClass || '';
      if (currentBadgeToneClass !== badgeToneClass) {
        if (badge.dataset.asgToneClass) badge.classList.remove(badge.dataset.asgToneClass);
        if (badgeToneClass) {
          badge.classList.add(badgeToneClass);
          badge.dataset.asgToneClass = badgeToneClass;
        } else {
          delete badge.dataset.asgToneClass;
        }
      }

      let status = leftColumn.querySelector('.asg-key-group-status');
      if (!status) {
        status = document.createElement('span');
        leftColumn.appendChild(status);
      }
      const statusClass = `asg-key-group-status asg-key-group-status-${info.statusTone}`;
      if (status.className !== statusClass) status.className = statusClass;
      if (status.textContent !== info.statusText) status.textContent = info.statusText;

      let latency = rightColumn.querySelector('.asg-key-group-latency');
      if (!latency) {
        latency = document.createElement('span');
        rightColumn.appendChild(latency);
      }
      if (latency.className !== 'asg-key-group-latency') latency.className = 'asg-key-group-latency';
      const latencyRenderKey = `${info.latencyText}|${info.latencyValueText}`;
      if (latency.dataset.renderKey !== latencyRenderKey) {
        if (info.latencyValueText) {
          const value = document.createElement('strong');
          value.className = 'asg-key-group-latency-value';
          value.textContent = info.latencyValueText;
          latency.replaceChildren(document.createTextNode('首 Token'), value);
        } else {
          latency.textContent = info.latencyText;
        }
        latency.dataset.renderKey = latencyRenderKey;
      }
    }
  }

  class UsageMultiplierEnhancer {
    constructor() {
      this.multiplierByGroup = new Map();
      this.observer = null;
      this.renderQueued = false;
      this.active = false;
      this.refreshTimer = null;
      this.renderTimer = null;
    }

    start() {
      this.active = true;
      addStyle(USAGE_STYLE);
      this.observer = new MutationObserver(() => this.queueRender());
      this.observer.observe(document.body, { childList: true, subtree: true });
      this.refresh();
      this.refreshTimer = window.setInterval(() => this.refresh(), 5 * 60 * 1000);
    }

    stop() {
      this.active = false;
      this.observer?.disconnect();
      this.observer = null;
      if (this.refreshTimer) window.clearInterval(this.refreshTimer);
      if (this.renderTimer) window.clearTimeout(this.renderTimer);
      this.refreshTimer = null;
      this.renderTimer = null;
      document.querySelectorAll('.asg-usage-multiplier').forEach((node) => node.remove());
    }

    async refresh() {
      try {
        const summary = await fetchMonitorSummary();
        if (!this.active) return;
        this.multiplierByGroup = buildGroupMultiplierMap(summary?.apis);
        this.render();
      } catch {
        // The usage page remains unchanged when current monitor data is unavailable.
      }
    }

    queueRender() {
      if (this.renderQueued) return;
      this.renderQueued = true;
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        this.renderQueued = false;
        this.render();
      }, 0);
    }

    render() {
      if (!this.multiplierByGroup.size) return;
      for (const table of document.querySelectorAll('table')) {
        const headers = [...table.querySelectorAll('thead th')];
        const groupColumnIndex = headers.findIndex((header) => header.textContent.trim() === '分组');
        if (groupColumnIndex < 0) continue;
        for (const row of table.querySelectorAll('tbody tr')) {
          const cells = row.querySelectorAll('td');
          const cell = cells[groupColumnIndex];
          if (!cell) continue;
          const existing = cell.querySelector('.asg-usage-multiplier');
          const name = normalizeGroupName([...cell.childNodes]
            .filter((node) => node !== existing)
            .map((node) => node.textContent)
            .join(' '));
          const multiplier = this.multiplierByGroup.get(name);
          if (multiplier == null) {
            existing?.remove();
            continue;
          }
          const text = formatMultiplier(multiplier);
          if (existing) {
            existing.dataset.groupName = name;
            if (existing.textContent !== text) existing.textContent = text;
          } else {
            const badge = document.createElement('span');
            badge.className = 'asg-usage-multiplier';
            badge.dataset.groupName = name;
            badge.textContent = text;
            cell.appendChild(badge);
          }
        }
      }
    }
  }

  // ===========================================================================
  // Sub2api 适配模块（不主动测活）
  // ---------------------------------------------------------------------------
  // 数据全部来自 sub2api 后台自身已有的 admin API（同源，复用页面里的 JWT）：
  //   GET  /api/v1/admin/accounts                     账号列表（含健康/冷却字段）
  //   POST /api/v1/admin/accounts/today-stats/batch   今日真实用量（请求数 / 花费）
  //   GET  /api/v1/admin/groups                        分组列表
  // 手动路由操作（均已验证：不会清空 API Key）：
  //   POST /api/v1/admin/accounts/:id/schedulable      摘出 / 挂回调度池
  //   POST /api/v1/admin/accounts/:id/recover-state    清除冷却 / 恢复
  //   PUT  /api/v1/admin/accounts/:id                  调整优先级（携带 group_ids）
  // 全程不调用任何 test / probe / 测活类接口。健康度只反映“真实流量触发的状态”。
  // ===========================================================================

  const SUB2_PANEL_ID = 'sub2-smart-group-panel';
  const SUB2_TOGGLE_ID = 'sub2-smart-group-toggle';
  const SUB2_STORAGE_PREFIX = 'sub2-smart-group:';
  const SUB2_API_BASE = '/api/v1';
  const SUB2_POLL_SECONDS = 30;
  const SUB2_TONE_RANK = Object.freeze({ ok: 0, warn: 1, paused: 2, down: 3 });
  // 排序专用次序（与健康推断的 TONE_RANK 分开）：真正有问题的置顶，主动停用的沉底。
  // down(不可用) 最需要处理 → 最前；paused(多为手动摘出) 已知处理 → 最后。
  const SUB2_SORT_RANK = Object.freeze({ down: 3, warn: 2, ok: 1, paused: 0 });
  const SUB2_TONE_LABELS = Object.freeze({ ok: '正常', warn: '注意', paused: '已停用', down: '不可用' });
  const SUB2_SORT_LABELS = Object.freeze({ health: '健康度', priority: '优先级', cost: '今日花费', name: '名称' });

  function sub2StorageGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const value = GM_getValue(SUB2_STORAGE_PREFIX + key, undefined);
        if (value !== undefined) return value;
      }
      const raw = window.localStorage.getItem(SUB2_STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function sub2StorageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(SUB2_STORAGE_PREFIX + key, value);
        return;
      }
      window.localStorage.setItem(SUB2_STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage failures are non-fatal; the panel simply forgets preferences.
    }
  }

  function sub2ReadAuthToken() {
    try {
      return window.localStorage.getItem('auth_token') || '';
    } catch {
      return '';
    }
  }

  // sub2api 前端把 JWT 存在 localStorage.auth_token。@match 已把站点限定在 sub2 后台，
  // 这里再用 token 存在性做一次确认，避免在无关页面渲染面板。
  function isSub2Host() {
    if (location.hostname === 'aihub.top') return false;
    return Boolean(sub2ReadAuthToken());
  }

  function sub2WorseTone(current, candidate) {
    return SUB2_TONE_RANK[candidate] > SUB2_TONE_RANK[current] ? candidate : current;
  }

  function sub2FormatUntil(timestamp, now) {
    const remainingMs = timestamp - now;
    if (remainingMs <= 0) return '即将';
    const totalSeconds = Math.ceil(remainingMs / 1000);
    if (totalSeconds < 60) return `${totalSeconds} 秒后`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒后` : `${minutes} 分钟后`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时后`;
  }

  function sub2FormatCost(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '0';
    return amount.toFixed(4).replace(/\.?0+$/, '') || '0';
  }

  function sub2FormatRelative(timestamp, now) {
    const parsed = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return '从未';
    const ageMs = Math.max(0, now - parsed);
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  }

  // 纯函数：根据账号的真实状态字段（非测活）推断健康度。
  // 返回 { tone, reasons[], schedulable, coolingUntil }。
  function sub2ComputeHealth(account, now = Date.now()) {
    const reasons = [];
    let tone = 'ok';
    const status = String(account?.status || '');
    const schedulable = account?.schedulable !== false;
    let coolingUntil = 0;

    if (status && status !== 'active') {
      tone = sub2WorseTone(tone, 'paused');
      reasons.push(`状态：${status}`);
    }

    const rateReset = Date.parse(account?.rate_limit_reset_at);
    if (Number.isFinite(rateReset) && rateReset > now) {
      tone = sub2WorseTone(tone, 'down');
      coolingUntil = Math.max(coolingUntil, rateReset);
      reasons.push(`限流中，${sub2FormatUntil(rateReset, now)}恢复`);
    }

    const overloadUntil = Date.parse(account?.overload_until);
    if (Number.isFinite(overloadUntil) && overloadUntil > now) {
      tone = sub2WorseTone(tone, 'down');
      coolingUntil = Math.max(coolingUntil, overloadUntil);
      reasons.push(`过载退避，${sub2FormatUntil(overloadUntil, now)}恢复`);
    }

    const tempUntil = Date.parse(account?.temp_unschedulable_until);
    if (Number.isFinite(tempUntil) && tempUntil > now) {
      tone = sub2WorseTone(tone, 'down');
      coolingUntil = Math.max(coolingUntil, tempUntil);
      const why = String(account?.temp_unschedulable_reason || '').trim();
      reasons.push(`临时熔断${why ? '：' + why : ''}（${sub2FormatUntil(tempUntil, now)}恢复）`);
    }

    if (!schedulable) {
      tone = sub2WorseTone(tone, 'paused');
      const why = String(account?.temp_unschedulable_reason || '').trim();
      if (tempUntil <= now || !Number.isFinite(tempUntil)) {
        reasons.push(why ? `已摘出：${why}` : '已摘出调度池');
      }
    }

    const errorMessage = String(account?.error_message || '').trim();
    if (errorMessage) {
      tone = sub2WorseTone(tone, 'warn');
      reasons.push(`最近错误：${errorMessage}`);
    }

    if (!reasons.length) reasons.push('正常');
    return { tone, reasons, schedulable, coolingUntil, status };
  }

  function sub2SortAccounts(accounts, statsById, mode, now = Date.now()) {
    const rows = Array.isArray(accounts) ? accounts.slice() : [];
    const healthRank = (account) => SUB2_SORT_RANK[sub2ComputeHealth(account, now).tone] ?? 0;
    const costOf = (account) => Number(statsById?.[account?.id]?.cost) || 0;
    const nameOf = (account) => String(account?.name || '').trim();
    if (mode === 'priority') {
      rows.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || nameOf(a).localeCompare(nameOf(b)));
    } else if (mode === 'cost') {
      rows.sort((a, b) => costOf(b) - costOf(a) || nameOf(a).localeCompare(nameOf(b)));
    } else if (mode === 'name') {
      rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    } else {
      // health：真正有问题的（不可用/注意）置顶，正常居中，主动停用沉底
      rows.sort((a, b) => healthRank(b) - healthRank(a)
        || (Number(a.priority) || 0) - (Number(b.priority) || 0)
        || nameOf(a).localeCompare(nameOf(b)));
    }
    return rows;
  }

  async function sub2ApiRequest(method, path, body) {
    const token = sub2ReadAuthToken();
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const options = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(SUB2_API_BASE + path, options);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (payload && typeof payload.code === 'number' && payload.code !== 0) {
      const error = new Error(payload.message || `业务错误 code=${payload.code}`);
      error.code = payload.code;
      throw error;
    }
    return payload ? payload.data : null;
  }

  async function sub2FetchAccounts() {
    const data = await sub2ApiRequest('GET', '/admin/accounts?page=1&page_size=200');
    return Array.isArray(data?.items) ? data.items : [];
  }

  async function sub2FetchTodayStats(accountIds) {
    if (!Array.isArray(accountIds) || !accountIds.length) return {};
    const data = await sub2ApiRequest('POST', '/admin/accounts/today-stats/batch', { account_ids: accountIds });
    return data?.stats || {};
  }

  async function sub2SetSchedulable(accountId, schedulable) {
    return sub2ApiRequest('POST', `/admin/accounts/${accountId}/schedulable`, { schedulable });
  }

  async function sub2RecoverState(accountId) {
    return sub2ApiRequest('POST', `/admin/accounts/${accountId}/recover-state`);
  }

  async function sub2UpdatePriority(account, priority) {
    // 只提交 priority + group_ids：已验证这样不会清空 credentials（API Key）。
    const groupIds = Array.isArray(account?.group_ids)
      ? account.group_ids
      : (Array.isArray(account?.account_groups) ? account.account_groups.map((entry) => entry.group_id) : []);
    return sub2ApiRequest('PUT', `/admin/accounts/${account.id}`, { priority, group_ids: groupIds });
  }

  const SUB2_STYLE = `
    #${SUB2_TOGGLE_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
      background:#2563eb;color:#fff;border:none;box-shadow:0 6px 18px rgba(37,99,235,.4);cursor:pointer;font-size:13px;font-weight:700;}
    #${SUB2_TOGGLE_ID}:hover{background:#1d4ed8;}
    #${SUB2_PANEL_ID}{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:420px;max-width:calc(100vw - 36px);
      max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:#fff;color:#0f172a;border:1px solid #e2e8f0;
      border-radius:12px;box-shadow:0 12px 40px rgba(15,23,42,.22);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      font-size:13px;overflow:hidden;}
    #${SUB2_PANEL_ID}.sub2-hidden{display:none;}
    #${SUB2_PANEL_ID} .sub2-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
      background:#0f172a;color:#fff;}
    #${SUB2_PANEL_ID} .sub2-head b{font-size:14px;}
    #${SUB2_PANEL_ID} .sub2-head .sub2-min{background:transparent;border:none;color:#cbd5e1;cursor:pointer;font-size:16px;line-height:1;}
    #${SUB2_PANEL_ID} .sub2-summary{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-chip{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;}
    #${SUB2_PANEL_ID} .sub2-chip.ok{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-chip.warn{background:#fef9c3;color:#854d0e;}
    #${SUB2_PANEL_ID} .sub2-chip.paused{background:#e2e8f0;color:#475569;}
    #${SUB2_PANEL_ID} .sub2-chip.down{background:#fee2e2;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-controls{display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid #f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-controls input,#${SUB2_PANEL_ID} .sub2-controls select{
      border:1px solid #cbd5e1;border-radius:6px;padding:4px 6px;font-size:12px;}
    #${SUB2_PANEL_ID} .sub2-controls input{flex:1;min-width:0;}
    #${SUB2_PANEL_ID} .sub2-refresh{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;}
    #${SUB2_PANEL_ID} .sub2-list{overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-row{border:1px solid #e2e8f0;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-row.tone-down{border-color:#fecaca;background:#fef2f2;}
    #${SUB2_PANEL_ID} .sub2-row.tone-warn{border-color:#fde68a;background:#fffbeb;}
    #${SUB2_PANEL_ID} .sub2-row.tone-paused{background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-row-top{display:flex;align-items:center;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-name{font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-badge{padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;}
    #${SUB2_PANEL_ID} .sub2-badge.ok{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-badge.warn{background:#fef9c3;color:#854d0e;}
    #${SUB2_PANEL_ID} .sub2-badge.paused{background:#e2e8f0;color:#475569;}
    #${SUB2_PANEL_ID} .sub2-badge.down{background:#fee2e2;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-platform{font-size:11px;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-meta{font-size:12px;color:#475569;display:flex;flex-wrap:wrap;gap:8px;}
    #${SUB2_PANEL_ID} .sub2-reasons{font-size:11px;color:#64748b;line-height:1.5;}
    #${SUB2_PANEL_ID} .sub2-actions{display:flex;flex-wrap:wrap;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-btn{border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-btn:hover{background:#f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-btn.danger{border-color:#fecaca;color:#b91c1c;}
    #${SUB2_PANEL_ID} .sub2-btn.primary{border-color:#bfdbfe;color:#1d4ed8;}
    #${SUB2_PANEL_ID} .sub2-btn:disabled{opacity:.5;cursor:not-allowed;}
    #${SUB2_PANEL_ID} .sub2-status{padding:6px 12px;border-top:1px solid #f1f5f9;font-size:11px;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-status.error{color:#b91c1c;}
  `;

  class Sub2Controller {
    constructor() {
      this.root = null;
      this.toggle = null;
      this.listElement = null;
      this.summaryElement = null;
      this.statusElement = null;
      this.searchElement = null;
      this.sortElement = null;
      this.accounts = [];
      this.statsById = {};
      this.refreshTimer = null;
      this.tickTimer = null;
      this.loading = false;
      this.busyIds = new Set();
      this.filterText = '';
      this.sortMode = String(sub2StorageGet('sortMode', 'health'));
      this.minimized = sub2StorageGet('minimized', false) === true;
      this.lastError = '';
      this.lastUpdatedAt = 0;
    }

    start() {
      if (typeof GM_addStyle === 'function') GM_addStyle(SUB2_STYLE);
      this.mount();
      this.refresh();
      this.refreshTimer = window.setInterval(() => this.refresh(), SUB2_POLL_SECONDS * 1000);
      // 每秒仅重绘倒计时文案，不发请求。
      this.tickTimer = window.setInterval(() => {
        if (!this.minimized && this.accounts.length) this.renderList();
      }, 1000);
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('显示 Sub2 智能分组面板', () => this.setMinimized(false));
      }
    }

    mount() {
      const existing = document.getElementById(SUB2_PANEL_ID);
      if (existing) existing.remove();
      const existingToggle = document.getElementById(SUB2_TOGGLE_ID);
      if (existingToggle) existingToggle.remove();

      this.toggle = document.createElement('button');
      this.toggle.id = SUB2_TOGGLE_ID;
      this.toggle.textContent = 'S2';
      this.toggle.title = 'Sub2 智能分组';
      this.toggle.addEventListener('click', () => this.setMinimized(!this.minimized));
      document.body.appendChild(this.toggle);

      this.root = document.createElement('div');
      this.root.id = SUB2_PANEL_ID;
      this.root.innerHTML = `
        <div class="sub2-head">
          <b>Sub2 账号健康 / 路由</b>
          <button class="sub2-min" title="最小化">—</button>
        </div>
        <div class="sub2-summary"></div>
        <div class="sub2-controls">
          <input type="text" placeholder="按名称筛选…" />
          <select>
            <option value="health">按健康度</option>
            <option value="priority">按优先级</option>
            <option value="cost">按今日花费</option>
            <option value="name">按名称</option>
          </select>
          <button class="sub2-refresh">刷新</button>
        </div>
        <div class="sub2-list"></div>
        <div class="sub2-status">加载中…</div>
      `;
      document.body.appendChild(this.root);

      this.summaryElement = this.root.querySelector('.sub2-summary');
      this.listElement = this.root.querySelector('.sub2-list');
      this.statusElement = this.root.querySelector('.sub2-status');
      this.searchElement = this.root.querySelector('.sub2-controls input');
      this.sortElement = this.root.querySelector('.sub2-controls select');

      this.sortElement.value = this.sortMode;
      this.root.querySelector('.sub2-min').addEventListener('click', () => this.setMinimized(true));
      this.root.querySelector('.sub2-refresh').addEventListener('click', () => this.refresh());
      this.searchElement.addEventListener('input', () => {
        this.filterText = this.searchElement.value.trim().toLocaleLowerCase();
        this.renderList();
      });
      this.sortElement.addEventListener('change', () => {
        this.sortMode = this.sortElement.value;
        sub2StorageSet('sortMode', this.sortMode);
        this.renderList();
      });

      this.applyMinimized();
    }

    setMinimized(minimized) {
      this.minimized = minimized === true;
      sub2StorageSet('minimized', this.minimized);
      this.applyMinimized();
      if (!this.minimized) this.refresh();
    }

    applyMinimized() {
      if (!this.root) return;
      this.root.classList.toggle('sub2-hidden', this.minimized);
    }

    async refresh() {
      if (this.loading) return;
      this.loading = true;
      try {
        const accounts = await sub2FetchAccounts();
        this.accounts = accounts;
        const ids = accounts.map((account) => account.id).filter((id) => Number.isFinite(Number(id)));
        try {
          this.statsById = await sub2FetchTodayStats(ids);
        } catch {
          this.statsById = this.statsById || {};
        }
        this.lastError = '';
        this.lastUpdatedAt = Date.now();
      } catch (error) {
        this.lastError = error?.status === 401
          ? '登录已失效，请重新登录 sub2 后台后再刷新。'
          : `读取失败：${error?.message || error}`;
      } finally {
        this.loading = false;
        this.render();
      }
    }

    render() {
      this.renderSummary();
      this.renderList();
      this.renderStatus();
    }

    renderSummary() {
      if (!this.summaryElement) return;
      const now = Date.now();
      const counts = { ok: 0, warn: 0, paused: 0, down: 0 };
      for (const account of this.accounts) {
        counts[sub2ComputeHealth(account, now).tone] += 1;
      }
      this.summaryElement.innerHTML = `
        <span class="sub2-chip ok">正常 ${counts.ok}</span>
        <span class="sub2-chip warn">注意 ${counts.warn}</span>
        <span class="sub2-chip down">不可用 ${counts.down}</span>
        <span class="sub2-chip paused">已停用 ${counts.paused}</span>
      `;
    }

    renderList() {
      if (!this.listElement) return;
      const now = Date.now();
      let rows = sub2SortAccounts(this.accounts, this.statsById, this.sortMode, now);
      if (this.filterText) {
        rows = rows.filter((account) => String(account?.name || '').toLocaleLowerCase().includes(this.filterText));
      }
      if (!rows.length) {
        this.listElement.innerHTML = '<div class="sub2-reasons" style="padding:10px;">没有匹配的账号。</div>';
        return;
      }
      this.listElement.textContent = '';
      for (const account of rows) {
        this.listElement.appendChild(this.buildRow(account, now));
      }
    }

    buildRow(account, now) {
      const health = sub2ComputeHealth(account, now);
      const stats = this.statsById?.[account.id] || {};
      const busy = this.busyIds.has(account.id);

      const row = document.createElement('div');
      row.className = `sub2-row tone-${health.tone}`;

      const top = document.createElement('div');
      top.className = 'sub2-row-top';
      const name = document.createElement('span');
      name.className = 'sub2-name';
      name.textContent = String(account.name || `账号 ${account.id}`).trim() || `账号 ${account.id}`;
      name.title = name.textContent;
      const badge = document.createElement('span');
      badge.className = `sub2-badge ${health.tone}`;
      badge.textContent = SUB2_TONE_LABELS[health.tone];
      const platform = document.createElement('span');
      platform.className = 'sub2-platform';
      platform.textContent = String(account.platform || '');
      top.append(name, badge, platform);

      const meta = document.createElement('div');
      meta.className = 'sub2-meta';
      const requests = Number(stats.requests) || 0;
      const cost = sub2FormatCost(stats.cost);
      meta.innerHTML = `
        <span>优先级 <b>${Number(account.priority) || 0}</b></span>
        <span>今日 ${requests} 次 / $${cost}</span>
        <span>最近使用 ${sub2FormatRelative(account.last_used_at, now)}</span>
      `;

      const reasons = document.createElement('div');
      reasons.className = 'sub2-reasons';
      reasons.textContent = health.reasons.join('；');

      const actions = document.createElement('div');
      actions.className = 'sub2-actions';

      const toggleBtn = document.createElement('button');
      toggleBtn.className = health.schedulable ? 'sub2-btn danger' : 'sub2-btn primary';
      toggleBtn.textContent = health.schedulable ? '摘出调度' : '挂回调度';
      toggleBtn.disabled = busy;
      toggleBtn.addEventListener('click', () => this.handleToggleSchedulable(account));
      actions.appendChild(toggleBtn);

      if (health.coolingUntil > now || health.tone === 'down') {
        const recoverBtn = document.createElement('button');
        recoverBtn.className = 'sub2-btn';
        recoverBtn.textContent = '清冷却';
        recoverBtn.disabled = busy;
        recoverBtn.addEventListener('click', () => this.handleRecover(account));
        actions.appendChild(recoverBtn);
      }

      const upBtn = document.createElement('button');
      upBtn.className = 'sub2-btn';
      upBtn.textContent = '优先级 ↑';
      upBtn.title = '数值 -1（更优先被调度）';
      upBtn.disabled = busy;
      upBtn.addEventListener('click', () => this.handlePriority(account, -1));
      actions.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.className = 'sub2-btn';
      downBtn.textContent = '优先级 ↓';
      downBtn.title = '数值 +1（更靠后被调度）';
      downBtn.disabled = busy;
      downBtn.addEventListener('click', () => this.handlePriority(account, 1));
      actions.appendChild(downBtn);

      row.append(top, meta, reasons, actions);
      return row;
    }

    renderStatus() {
      if (!this.statusElement) return;
      this.statusElement.classList.toggle('error', Boolean(this.lastError));
      if (this.lastError) {
        this.statusElement.textContent = this.lastError;
        return;
      }
      const when = this.lastUpdatedAt ? sub2FormatRelative(this.lastUpdatedAt, Date.now()) : '刚刚';
      this.statusElement.textContent = `共 ${this.accounts.length} 个账号 · 更新于 ${when} · 每 ${SUB2_POLL_SECONDS}s 自动刷新（只读，不测活）`;
    }

    setBusy(accountId, busy) {
      if (busy) this.busyIds.add(accountId);
      else this.busyIds.delete(accountId);
      this.renderList();
    }

    async handleToggleSchedulable(account) {
      const target = !(account.schedulable !== false);
      const verb = target ? '挂回调度池' : '摘出调度池';
      if (!window.confirm(`确认将账号「${account.name}」${verb}？`)) return;
      this.setBusy(account.id, true);
      try {
        await sub2SetSchedulable(account.id, target);
        await this.refresh();
      } catch (error) {
        this.lastError = `操作失败：${error?.message || error}`;
        this.renderStatus();
      } finally {
        this.setBusy(account.id, false);
      }
    }

    async handleRecover(account) {
      if (!window.confirm(`确认清除账号「${account.name}」的冷却/限流状态并恢复调度？`)) return;
      this.setBusy(account.id, true);
      try {
        await sub2RecoverState(account.id);
        await this.refresh();
      } catch (error) {
        this.lastError = `清冷却失败：${error?.message || error}`;
        this.renderStatus();
      } finally {
        this.setBusy(account.id, false);
      }
    }

    async handlePriority(account, delta) {
      const current = Number(account.priority) || 0;
      const next = Math.max(0, current + delta);
      if (next === current) return;
      if (!window.confirm(`将账号「${account.name}」优先级从 ${current} 调整为 ${next}？`)) return;
      this.setBusy(account.id, true);
      try {
        await sub2UpdatePriority(account, next);
        await this.refresh();
      } catch (error) {
        this.lastError = `调整优先级失败：${error?.message || error}`;
        this.renderStatus();
      } finally {
        this.setBusy(account.id, false);
      }
    }
  }


  class AppRouter {
    constructor() {
      this.panel = null;
      this.usage = null;
      this.keyGroups = null;
      this.rejectedToken = '';
      this.timer = null;
    }

    start() {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('显示 AIHub 智能分组', () => {
          this.panel?.setMinimized(false);
        });
      }
      this.sync();
      this.timer = window.setInterval(() => this.sync(), 500);
    }

    sync() {
      const token = getAuthToken();
      if (!token) this.rejectedToken = '';
      const features = getPageFeatures(location.pathname, Boolean(token) && token !== this.rejectedToken);
      if (features.panel && !this.panel) {
        this.panel = new Controller({
          onAuthInvalid: () => {
            this.rejectedToken = token;
            this.sync();
          },
        });
        this.panel.start(false);
      } else if (!features.panel && this.panel) {
        this.panel.stop();
        this.panel = null;
      }
      if (features.usage && !this.usage) {
        this.usage = new UsageMultiplierEnhancer();
        this.usage.start();
      } else if (!features.usage && this.usage) {
        this.usage.stop();
        this.usage = null;
      }
      if (features.keyGroups && !this.keyGroups) {
        this.keyGroups = new KeyGroupDropdownEnhancer();
        this.keyGroups.start();
      } else if (!features.keyGroups && this.keyGroups) {
        this.keyGroups.stop();
        this.keyGroups = null;
      }
    }
  }

  return {
    DEFAULT_CONFIG,
    GROUP_MODE_LABELS,
    normalizeConfig,
    normalizeGroupMode,
    normalizeAvailabilityMode,
    normalizePanelTab,
    getBalanceAmount,
    formatBalance,
    getExcludedGroupInfo,
    analyzeCandidates,
    rankCandidates,
    getMonitorFreshness,
    getLatestMonitorSampleAt,
    getCooldownInfo,
    attachRecentAvailability,
    normalizeGroupName,
    buildGroupMultiplierMap,
    buildGroupMetricMap,
    buildGroupDropdownMonitorIndex,
    findGroupDropdownMonitor,
    parseGroupOptionMultiplier,
    formatGroupDropdownMonitor,
    getGroupDropdownToneClass,
    formatKeyOptionLabel,
    formatMultiplier,
    getPageFeatures,
    createStabilityState,
    advanceStability,
    canAutoSwitch,
    getAutoSwitchBlockReason,
    shouldLogTransition,
    getSwitchBlockReason,
    projectKeys,
    buildAuthHeaders,
    buildApiHeaders,
    mergeKeyPages,
    shouldRefreshKeys,
    appendLogEntries,
    formatLogLine,
    start() {
      if (location.hostname === 'aihub.top') {
        new AppRouter().start();
        return;
      }
      if (isSub2Host()) {
        new Sub2Controller().start();
        return;
      }
    },
  };
});
