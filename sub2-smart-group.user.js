// ==UserScript==
// @name         Sub2 Smart Group
// @name:zh-CN   Sub2 智能分组
// @namespace    local.sub2.smart-group
// @version      2.4.0
// @description  Sub2 account health, route history, reliability events, protected controls, and manual model sync (no active probing).
// @description:zh-CN 为 sub2api 提供账号健康度、路由历史、可靠性事件、受保护控制与手动模型同步（不主动测活）
// @license      MIT
// @homepageURL   https://github.com/hong594/sub2-smart-group
// @supportURL    https://github.com/hong594/sub2-smart-group/issues
// @updateURL     https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js
// @downloadURL   https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js
// @match        http://localhost:18080/*
// @match        http://127.0.0.1:18080/*
// @match        http://localhost:8080/*
// @match        http://127.0.0.1:8080/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

//
// 说明：本脚本默认匹配 localhost:18080 / 8080 等本地地址。
// 如果你通过内网 IP、自定义域名或 HTTPS 访问 sub2api 后台，请在 Tampermonkey 设置中
// 添加“用户匹配”，或自行补一行 @match，例如：
//   // @match http://192.168.x.x:18080/*
//   // @match https://your-sub2-domain.com/*
// 脚本仅在检测到 sub2api 后台登录令牌时启动，且不会主动调用测活接口。

/* global module, GM_info */

(function (factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') exported.start();
})(function () {
  'use strict';

  // ===========================================================================
  // Sub2api 适配模块（不主动测活）
  // ---------------------------------------------------------------------------
  // 数据全部来自 sub2api 后台自身已有的 admin API（同源，复用页面里的 JWT）：
  //   GET  /api/v1/admin/accounts                     账号列表（含健康/冷却字段）
  //   POST /api/v1/admin/accounts/today-stats/batch   今日真实用量（请求数 / 花费）
  //   GET  /api/v1/admin/groups/all                    完整分组列表
  //   GET  /api/v1/admin/ops/concurrency               当前容量 / 并发 / 排队快照
  //   GET  /api/v1/admin/ops/requests                  最近真实请求
  //   GET  /api/v1/admin/ops/upstream-errors           真实上游故障摘要
  //   GET  /api/v1/admin/ops/upstream-errors/:id       故障转移事件详情
  // 手动操作（不读取或提交 API Key）：
  //   POST /api/v1/admin/accounts/:id/schedulable      摘出 / 挂回调度池
  //   POST /api/v1/admin/accounts/:id/recover-state    清除冷却 / 恢复
  //   PUT  /api/v1/admin/accounts/:id                  仅调整账号优先级 / 并发容量
  //   GET  /api/v1/admin/accounts/:id/models           查看 sub2 已保存的模型
  //   POST /api/v1/admin/accounts/:id/models/sync-upstream
  //                                                        用户点击后拉取并同步上游模型
  // 不调用任何 test / probe / 测活类接口。模型同步只会由用户明确点击触发，
  // 健康度仍然只反映“真实流量触发的状态”。
  // ===========================================================================

  const SUB2_PANEL_ID = 'sub2-smart-group-panel';
  const SUB2_TOGGLE_ID = 'sub2-smart-group-toggle';
  const SUB2_STORAGE_PREFIX = 'sub2-smart-group:';
  const SUB2_API_BASE = '/api/v1';
  const SUB2_POLL_SECONDS = 10;
  const SUB2_ROUTING_LOOKBACK_MS = 30 * 60 * 1000;
  const SUB2_REQUEST_HISTORY_LIMIT = 30;
  const SUB2_RELIABILITY_HISTORY_LIMIT = 1000;
  const SUB2_EVENT_RETENTION_OPTIONS = Object.freeze([1, 7, 30]);
  const SUB2_DEFAULT_EVENT_RETENTION_DAYS = 7;
  const SUB2_LOCAL_EVENT_LIMIT = 500;
  const SUB2_RELIABILITY_REFRESH_MS = 60 * 1000;
  const SUB2_CAPACITY_MAX = 10000;
  const SUB2_AUDIT_SEVERITY_RANK = Object.freeze({ critical: 2, warning: 1, info: 0 });
  const SUB2_AUDIT_SEVERITY_LABELS = Object.freeze({ critical: '严重', warning: '注意', info: '提示' });
  const SUB2_CAPACITY_ADVICE_WINDOW_HOURS = 24;
  // 近 24 小时 429 占比超过该比例才建议下调容量，避免偶发限流触发误建议。
  const SUB2_CAPACITY_RATE_LIMIT_RATIO = 0.05;
  // 当前占用达到配置容量的该比例才建议上调容量。
  const SUB2_CAPACITY_HIGH_LOAD_RATIO = 0.8;
  const SUB2_SCRIPT_VERSION = typeof GM_info !== 'undefined' && GM_info?.script?.version
    ? String(GM_info.script.version)
    : '2.4.0';
  const SUB2_TONE_RANK = Object.freeze({ ok: 0, warn: 1, paused: 2, down: 3 });
  // 排序专用次序（与健康推断的 TONE_RANK 分开）：真正有问题的置顶，主动停用的沉底。
  // down(不可用) 最需要处理 → 最前；paused(多为手动摘出) 已知处理 → 最后。
  const SUB2_SORT_RANK = Object.freeze({ down: 3, warn: 2, ok: 1, paused: 0 });
  const SUB2_TONE_LABELS = Object.freeze({ ok: '正常', warn: '注意', paused: '已停用', down: '不可用' });
  const SUB2_SORT_LABELS = Object.freeze({ health: '健康度', priority: '优先级', cost: '今日花费', name: '名称' });
  const SUB2_DAY_MS = 24 * 60 * 60 * 1000;
  const SUB2_WEEK_MS = 7 * SUB2_DAY_MS;
  const SUB2_OPENAI_OAUTH_FOREIGN_MODEL_PREFIXES = Object.freeze([
    'deepseek-', 'glm-', 'kimi-', 'moonshot-', 'qwen-', 'qwen2-', 'qwen3-', 'qwen4-', 'qwq-',
    'minimax-', 'gemini-', 'gemma-', 'grok-', 'doubao-', 'hunyuan-', 'llama-', 'llama2-',
    'llama3-', 'meta-llama', 'mistral-', 'mixtral-', 'baichuan-', 'ernie-', 'step-', 'seed-', 'yi-',
  ]);

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

  function sub2FormatDuration(durationMs) {
    if (durationMs === null || durationMs === undefined || durationMs === '') return '耗时未知';
    const numericDuration = Number(durationMs);
    if (!Number.isFinite(numericDuration) || numericDuration < 0) return '耗时未知';
    if (numericDuration < 1000) return `${Math.round(numericDuration)} ms`;
    if (numericDuration < 60000) return `${(numericDuration / 1000).toFixed(numericDuration < 10000 ? 1 : 0)} 秒`;
    const wholeMinutes = Math.floor(numericDuration / 60000);
    const remainingSeconds = Math.round((numericDuration % 60000) / 1000);
    return remainingSeconds > 0 ? `${wholeMinutes} 分 ${remainingSeconds} 秒` : `${wholeMinutes} 分钟`;
  }

  function sub2GetNumericAccountField(account, fieldName) {
    const value = account?.[fieldName] ?? account?.extra?.[fieldName];
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }

  function sub2HasOwnProperty(source, propertyName) {
    return Boolean(source) && Object.prototype.hasOwnProperty.call(source, propertyName);
  }

  function sub2ParseTimestamp(value) {
    if (value === null || value === undefined || value === '') return Number.NaN;
    const numericValue = typeof value === 'number'
      ? value
      : /^-?\d+(?:\.\d+)?$/.test(String(value).trim())
        ? Number(value)
        : Number.NaN;
    if (Number.isFinite(numericValue)) {
      return Math.abs(numericValue) < 100000000000 ? numericValue * 1000 : numericValue;
    }
    return Date.parse(value);
  }

  function sub2ResolveTimeZone(timeZoneName) {
    const candidateTimeZone = String(timeZoneName || 'UTC').trim() || 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidateTimeZone }).format(0);
      return candidateTimeZone;
    } catch {
      return 'UTC';
    }
  }

  function sub2GetZonedCalendarParts(timestamp, timeZoneName) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZoneName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const partsByType = {};
    for (const part of formatter.formatToParts(new Date(timestamp))) {
      if (part.type !== 'literal') partsByType[part.type] = Number(part.value);
    }
    return {
      year: partsByType.year,
      month: partsByType.month,
      day: partsByType.day,
      hour: partsByType.hour,
      minute: partsByType.minute,
      second: partsByType.second,
    };
  }

  function sub2ShiftCalendarDate(calendarParts, dayOffset) {
    const shiftedDate = new Date(Date.UTC(
      calendarParts.year,
      calendarParts.month - 1,
      calendarParts.day + dayOffset,
    ));
    return {
      year: shiftedDate.getUTCFullYear(),
      month: shiftedDate.getUTCMonth() + 1,
      day: shiftedDate.getUTCDate(),
    };
  }

  function sub2ZonedDateTimeToTimestamp(calendarParts, timeZoneName) {
    const targetAsUtc = Date.UTC(
      calendarParts.year,
      calendarParts.month - 1,
      calendarParts.day,
      calendarParts.hour || 0,
      calendarParts.minute || 0,
      calendarParts.second || 0,
    );
    let timestamp = targetAsUtc;
    // Intl 没有直接把 IANA 墙上时间转为 UTC 的 API。迭代修正时区偏移，
    // 可以同时覆盖整点重置和绝大多数 DST 切换边界。
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const actualParts = sub2GetZonedCalendarParts(timestamp, timeZoneName);
      const actualAsUtc = Date.UTC(
        actualParts.year,
        actualParts.month - 1,
        actualParts.day,
        actualParts.hour,
        actualParts.minute,
        actualParts.second,
      );
      const correction = targetAsUtc - actualAsUtc;
      timestamp += correction;
      if (correction === 0) break;
    }
    return timestamp;
  }

  function sub2GetLastFixedQuotaReset(account, dimension, now = Date.now()) {
    const timeZoneName = sub2ResolveTimeZone(
      account?.quota_reset_timezone ?? account?.extra?.quota_reset_timezone,
    );
    const nowParts = sub2GetZonedCalendarParts(now, timeZoneName);
    const resetHourField = dimension === 'weekly' ? 'quota_weekly_reset_hour' : 'quota_daily_reset_hour';
    const rawResetHour = sub2GetNumericAccountField(account, resetHourField);
    const resetHour = Number.isInteger(rawResetHour) && rawResetHour >= 0 && rawResetHour <= 23
      ? rawResetHour
      : 0;
    const todayReset = sub2ZonedDateTimeToTimestamp({
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: resetHour,
    }, timeZoneName);

    if (dimension === 'daily') {
      const resetDate = now < todayReset ? sub2ShiftCalendarDate(nowParts, -1) : nowParts;
      return sub2ZonedDateTimeToTimestamp({ ...resetDate, hour: resetHour }, timeZoneName);
    }

    const rawResetDay = account?.quota_weekly_reset_day ?? account?.extra?.quota_weekly_reset_day;
    const numericResetDay = Number(rawResetDay);
    const resetDay = Number.isInteger(numericResetDay) && numericResetDay >= 0 && numericResetDay <= 6
      ? numericResetDay
      : 1;
    const localDateAsUtc = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));
    const currentDay = localDateAsUtc.getUTCDay();
    let daysBack = (currentDay - resetDay + 7) % 7;
    if (daysBack === 0 && now < todayReset) daysBack = 7;
    const resetDate = sub2ShiftCalendarDate(nowParts, -daysBack);
    return sub2ZonedDateTimeToTimestamp({ ...resetDate, hour: resetHour }, timeZoneName);
  }

  function sub2IsQuotaPeriodExpired(account, dimension, now = Date.now()) {
    const startField = dimension === 'weekly' ? 'quota_weekly_start' : 'quota_daily_start';
    const periodStart = sub2ParseTimestamp(account?.[startField] ?? account?.extra?.[startField]);
    if (!Number.isFinite(periodStart)) return true;
    const modeField = dimension === 'weekly' ? 'quota_weekly_reset_mode' : 'quota_daily_reset_mode';
    const resetMode = String((account?.[modeField] ?? account?.extra?.[modeField]) || 'rolling').trim();
    if (resetMode === 'fixed') {
      return periodStart < sub2GetLastFixedQuotaReset(account, dimension, now);
    }
    const duration = dimension === 'weekly' ? SUB2_WEEK_MS : SUB2_DAY_MS;
    return now - periodStart >= duration;
  }

  function sub2GetQuotaUsageSnapshot(account, dimension, now = Date.now()) {
    const fieldPrefix = dimension === 'total' ? 'quota' : `quota_${dimension}`;
    const limitField = `${fieldPrefix}_limit`;
    const usedField = `${fieldPrefix}_used`;
    const limit = sub2GetNumericAccountField(account, limitField);
    let used = sub2GetNumericAccountField(account, usedField);
    let periodExpired = false;

    if (dimension !== 'total') {
      const backendProvidedNormalizedUsage = sub2HasOwnProperty(account, usedField)
        && account?.[usedField] !== null
        && account?.[usedField] !== undefined;
      if (!backendProvidedNormalizedUsage) {
        periodExpired = sub2IsQuotaPeriodExpired(account, dimension, now);
        if (periodExpired) used = 0;
      }
    }

    return { dimension, limit, used, periodExpired, exceeded: limit > 0 && used >= limit };
  }

  function sub2GetOptionalNumericValue(source, fieldName) {
    const rawValue = source?.[fieldName];
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function sub2NormalizeConcurrencySnapshot(payload) {
    const concurrencyByAccountId = new Map();
    const concurrencyRecordsByAccountId = new Map();
    const accountRecords = payload?.account;
    const accountEntries = Array.isArray(accountRecords)
      ? accountRecords.map((accountRecord) => [accountRecord?.account_id, accountRecord])
      : accountRecords && typeof accountRecords === 'object'
        ? Object.entries(accountRecords)
        : [];

    for (const [recordKey, accountRecord] of accountEntries) {
      if (!accountRecord || typeof accountRecord !== 'object') continue;
      const accountId = Number(accountRecord.account_id ?? recordKey);
      if (!Number.isInteger(accountId) || accountId <= 0) continue;

      const normalizedRecord = {
        accountId,
        groupId: Number.isInteger(Number(accountRecord.group_id)) && Number(accountRecord.group_id) > 0
          ? Number(accountRecord.group_id)
          : null,
        currentInUse: sub2GetOptionalNumericValue(accountRecord, 'current_in_use'),
        maxCapacity: sub2GetOptionalNumericValue(accountRecord, 'max_capacity'),
        loadPercentage: sub2GetOptionalNumericValue(accountRecord, 'load_percentage'),
        waitingInQueue: sub2GetOptionalNumericValue(accountRecord, 'waiting_in_queue'),
      };
      const accountRecordsForGroups = concurrencyRecordsByAccountId.get(accountId) || [];
      accountRecordsForGroups.push(normalizedRecord);
      concurrencyRecordsByAccountId.set(accountId, accountRecordsForGroups);

      // 卡片只能展示一个账号级摘要。选取真实存在且负载最高的分组记录，
      // 不能把不同分组的字段分别取最大值后拼成一个不存在的容量状态。
      const previousRecord = concurrencyByAccountId.get(accountId);
      const recordLoad = (record) => {
        if (Number.isFinite(record?.loadPercentage)) return record.loadPercentage;
        if (Number.isFinite(record?.currentInUse) && Number.isFinite(record?.maxCapacity) && record.maxCapacity > 0) {
          return record.currentInUse / record.maxCapacity * 100;
        }
        return 0;
      };
      const shouldReplacePrevious = !previousRecord
        || recordLoad(normalizedRecord) > recordLoad(previousRecord)
        || (recordLoad(normalizedRecord) === recordLoad(previousRecord)
          && (normalizedRecord.waitingInQueue ?? 0) > (previousRecord.waitingInQueue ?? 0));
      if (shouldReplacePrevious) concurrencyByAccountId.set(accountId, normalizedRecord);
    }

    const parsedTimestamp = Date.parse(payload?.timestamp);
    return {
      enabled: payload?.enabled === true,
      timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
      byAccountId: concurrencyByAccountId,
      recordsByAccountId: concurrencyRecordsByAccountId,
    };
  }

  function sub2ResolveAccountConcurrency(
    accountId,
    requestGroupId,
    concurrencyByAccountId,
    concurrencyRecordsByAccountId,
    fallbackToAccountSummary = true,
  ) {
    const numericAccountId = Number(accountId);
    const numericRequestGroupId = Number(requestGroupId);
    const accountRecords = concurrencyRecordsByAccountId?.get?.(numericAccountId) || [];
    if (Number.isInteger(numericRequestGroupId) && numericRequestGroupId > 0) {
      const matchingGroupRecord = accountRecords.find(
        (concurrencyRecord) => concurrencyRecord.groupId === numericRequestGroupId,
      );
      if (matchingGroupRecord) return matchingGroupRecord;
      if (!fallbackToAccountSummary) return null;
    }
    return concurrencyByAccountId?.get?.(numericAccountId) || null;
  }

  function sub2SummarizeConcurrency(concurrencyByAccountId) {
    const summary = { currentInUse: 0, maxCapacity: 0, waitingInQueue: 0, accountCount: 0 };
    if (!concurrencyByAccountId || typeof concurrencyByAccountId.values !== 'function') return summary;
    for (const concurrency of concurrencyByAccountId.values()) {
      summary.currentInUse += Math.max(0, concurrency?.currentInUse ?? 0);
      summary.maxCapacity += Math.max(0, concurrency?.maxCapacity ?? 0);
      summary.waitingInQueue += Math.max(0, concurrency?.waitingInQueue ?? 0);
      summary.accountCount += 1;
    }
    return summary;
  }

  function sub2SupportsDailyQuota(account) {
    const accountType = String(account?.type || '').trim();
    return accountType === 'apikey' || accountType === 'bedrock';
  }

  function sub2GetUpstreamBaseUrl(account) {
    const candidates = [
      account?.credentials?.base_url,
      account?.base_url,
      account?.upstream_base_url,
    ];
    for (const candidate of candidates) {
      const baseUrl = String(candidate || '').trim();
      if (baseUrl) return baseUrl;
    }
    return '';
  }

  function sub2GetUpstreamWebsiteUrl(account) {
    const baseUrl = sub2GetUpstreamBaseUrl(account);
    if (!baseUrl) return '';
    try {
      const parsedUrl = new URL(baseUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return '';
      return `${parsedUrl.origin}/`;
    } catch {
      return '';
    }
  }

  function sub2GetPoolModeState(account) {
    const accountType = String(account?.type || '').trim();
    if (accountType !== 'apikey' && accountType !== 'bedrock') return null;
    const credentials = account?.credentials;
    return Boolean(credentials && typeof credentials === 'object' && credentials.pool_mode === true);
  }

  function sub2BuildDailyQuotaExtra(sourceExtra, dailyLimit) {
    const updatedExtra = sourceExtra && typeof sourceExtra === 'object'
      ? { ...sourceExtra }
      : {};
    if (dailyLimit === null) {
      delete updatedExtra.quota_daily_limit;
      delete updatedExtra.quota_daily_used;
      delete updatedExtra.quota_daily_start;
    } else {
      updatedExtra.quota_daily_limit = dailyLimit;
    }
    return updatedExtra;
  }

  function sub2GetPaginatedItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.list)) return payload.list;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function sub2IsPaginatedPayloadComplete(payload) {
    const items = sub2GetPaginatedItems(payload);
    const numericTotal = Number(payload?.total);
    return !Number.isFinite(numericTotal) || numericTotal <= items.length;
  }

  function sub2NormalizeRequestHistory(payload) {
    const normalizedRequests = [];
    for (const requestItem of sub2GetPaginatedItems(payload)) {
      const createdAt = Date.parse(requestItem?.created_at);
      if (!Number.isFinite(createdAt)) continue;

      const kind = requestItem?.kind === 'error' ? 'error' : 'success';
      const numericAccountId = Number(requestItem?.account_id);
      const numericGroupId = Number(requestItem?.group_id);
      const rawDurationMs = requestItem?.duration_ms;
      const numericDurationMs = Number(rawDurationMs);
      const numericStatusCode = Number(requestItem?.status_code);
      const numericErrorId = Number(requestItem?.error_id);
      const requestId = String(requestItem?.request_id || '').trim();
      normalizedRequests.push({
        accountId: Number.isInteger(numericAccountId) && numericAccountId > 0 ? numericAccountId : null,
        createdAt,
        durationMs: rawDurationMs !== null
          && rawDurationMs !== undefined
          && Number.isFinite(numericDurationMs)
          && numericDurationMs >= 0
          ? numericDurationMs
          : null,
        errorId: Number.isInteger(numericErrorId) && numericErrorId > 0 ? numericErrorId : null,
        groupId: Number.isInteger(numericGroupId) && numericGroupId > 0 ? numericGroupId : null,
        kind,
        message: String(requestItem?.message || '').trim(),
        model: String(requestItem?.model || '').trim(),
        phase: String(requestItem?.phase || '').trim(),
        platform: String(requestItem?.platform || '').trim(),
        requestId,
        routeStatus: kind === 'error' ? 'error' : 'unknown',
        source: 'ops',
        statusCode: Number.isInteger(numericStatusCode) && numericStatusCode >= 100 && numericStatusCode <= 599
          ? numericStatusCode
          : null,
      });
    }
    return normalizedRequests.sort((leftRequest, rightRequest) => rightRequest.createdAt - leftRequest.createdAt);
  }

  function sub2GetRequestHistoryKey(requestItem) {
    const requestId = String(requestItem?.requestId || '').trim();
    if (requestId) return requestId;
    return [
      requestItem?.kind || 'unknown',
      Number(requestItem?.createdAt) || 0,
      Number(requestItem?.accountId) || 0,
      requestItem?.model || '',
    ].join(':');
  }

  function sub2AnnotateRequestHistory(requestHistory, errorPayload, errorCoverageComplete) {
    return (Array.isArray(requestHistory) ? requestHistory : []).map((requestItem) => {
      if (requestItem.kind === 'error') return { ...requestItem, routeStatus: 'error' };
      const correlatedErrors = sub2GetCorrelatedRoutingErrors(errorPayload, requestItem);
      return {
        ...requestItem,
        routeStatus: correlatedErrors.length
          ? 'failover'
          : errorCoverageComplete ? 'direct' : 'unknown',
      };
    });
  }

  function sub2NormalizeRecentRequest(payload) {
    return sub2NormalizeRequestHistory(payload).find(
      (requestItem) => requestItem.kind === 'success' && requestItem.accountId,
    ) || null;
  }

  function sub2ParseCapacityInput(rawCapacity, maximumCapacity = SUB2_CAPACITY_MAX) {
    const normalizedValue = String(rawCapacity ?? '').trim();
    if (!/^\d+$/.test(normalizedValue)) {
      return { value: null, error: '容量必须是正整数。' };
    }
    const numericCapacity = Number(normalizedValue);
    if (!Number.isSafeInteger(numericCapacity) || numericCapacity < 1) {
      return { value: null, error: '容量必须至少为 1。' };
    }
    if (numericCapacity > maximumCapacity) {
      return { value: null, error: `容量不能超过 ${maximumCapacity}。` };
    }
    return { value: numericCapacity, error: '' };
  }

  function sub2ExtractRoutingStatusCode(errorItem) {
    const explicitStatusCode = Number(errorItem?.upstream_status_code);
    if (Number.isInteger(explicitStatusCode) && explicitStatusCode >= 100 && explicitStatusCode <= 599) {
      return explicitStatusCode;
    }

    const message = String(errorItem?.message || '');
    const messageMatch = message.match(/(?:upstream\s+error|HTTP|status(?:\s+code)?)\s*:?\s*(\d{3})/i);
    if (messageMatch) return Number(messageMatch[1]);

    // upstream-errors 列表会把 COALESCE(upstream_status_code, status_code) 投影为 status_code。
    const projectedStatusCode = Number(errorItem?.status_code);
    return Number.isInteger(projectedStatusCode) && projectedStatusCode >= 400 && projectedStatusCode <= 599
      ? projectedStatusCode
      : null;
  }

  function sub2NormalizeCorrelationId(value) {
    return String(value || '').trim().replace(/^(?:(?:client|local):)+/i, '');
  }

  function sub2NormalizeRoutingError(errorItem) {
    const accountId = Number(errorItem?.account_id);
    const createdAt = Date.parse(errorItem?.created_at);
    if (!Number.isInteger(accountId) || accountId <= 0 || !Number.isFinite(createdAt)) return null;

    const rawMessage = String(errorItem?.message || '').trim();
    const statusCode = sub2ExtractRoutingStatusCode(errorItem);
    const recovered = /^Recovered (?:upstream error|account authentication failure)/i.test(rawMessage);
    const detail = rawMessage
      .replace(/^Recovered upstream error(?:\s+\d{3})?\s*:?\s*/i, '')
      .replace(/^Recovered account authentication failure(?:\s+\d{3})?\s*:?\s*/i, '')
      .replace(/\s*\(request id:.*\)\s*$/i, '')
      .trim();

    return {
      id: Number.isInteger(Number(errorItem?.id)) && Number(errorItem.id) > 0
        ? Number(errorItem.id)
        : null,
      accountId,
      accountName: String(errorItem?.account_name || '').trim(),
      createdAt,
      statusCode,
      recovered,
      detail: detail && detail !== rawMessage ? detail : detail || rawMessage,
      model: String(errorItem?.model || '').trim(),
      requestId: String(errorItem?.request_id || '').trim(),
      clientRequestId: String(errorItem?.client_request_id || '').trim(),
      correlated: false,
    };
  }

  function sub2RoutingErrorMatchesRequest(routingError, recentRequest) {
    const recentCorrelationId = sub2NormalizeCorrelationId(recentRequest?.requestId);
    if (!recentCorrelationId || !routingError) return false;
    return [routingError.requestId, routingError.clientRequestId]
      .map(sub2NormalizeCorrelationId)
      .filter(Boolean)
      .includes(recentCorrelationId);
  }

  function sub2GetCorrelatedRoutingErrors(payload, recentRequest) {
    const correlatedErrors = [];
    for (const errorItem of sub2GetPaginatedItems(payload)) {
      const routingError = sub2NormalizeRoutingError(errorItem);
      if (!routingError || !sub2RoutingErrorMatchesRequest(routingError, recentRequest)) continue;
      routingError.correlated = true;
      correlatedErrors.push(routingError);
    }
    return correlatedErrors.sort((leftError, rightError) => leftError.createdAt - rightError.createdAt);
  }

  function sub2NormalizeRoutingErrors(payload) {
    return sub2GetPaginatedItems(payload)
      .map((errorItem) => sub2NormalizeRoutingError(errorItem))
      .filter(Boolean)
      .sort((leftError, rightError) => rightError.createdAt - leftError.createdAt);
  }

  function sub2IsTrackedReliabilityStatus(statusCode) {
    const numericStatusCode = Number(statusCode);
    return numericStatusCode === 403 || numericStatusCode === 429
      || (numericStatusCode >= 500 && numericStatusCode <= 599);
  }

  function sub2GetReliabilityEventType(statusCode) {
    const numericStatusCode = Number(statusCode);
    if (numericStatusCode === 403) return 'status-403';
    if (numericStatusCode === 429) return 'status-429';
    if (numericStatusCode >= 500 && numericStatusCode <= 599) return 'status-5xx';
    return '';
  }

  function sub2NormalizeLocalEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const eventId = String(rawEvent.id || '').trim();
    const occurredAt = Number(rawEvent.occurredAt);
    if (!eventId || !Number.isFinite(occurredAt) || occurredAt <= 0) return null;
    const numericAccountId = Number(rawEvent.accountId);
    const numericGroupId = Number(rawEvent.groupId);
    const numericStatusCode = Number(rawEvent.statusCode);
    return {
      id: eventId,
      type: String(rawEvent.type || 'unknown').trim() || 'unknown',
      tone: String(rawEvent.tone || 'info').trim() || 'info',
      occurredAt,
      accountId: Number.isInteger(numericAccountId) && numericAccountId > 0 ? numericAccountId : null,
      accountName: String(rawEvent.accountName || '').trim(),
      groupId: Number.isInteger(numericGroupId) && numericGroupId > 0 ? numericGroupId : null,
      model: String(rawEvent.model || '').trim(),
      requestId: String(rawEvent.requestId || '').trim(),
      statusCode: Number.isInteger(numericStatusCode) ? numericStatusCode : null,
      title: String(rawEvent.title || '').trim(),
      detail: String(rawEvent.detail || '').trim(),
      source: String(rawEvent.source || 'local').trim() || 'local',
    };
  }

  function sub2NormalizeEventRetentionDays(rawRetentionDays) {
    const numericRetentionDays = Number(rawRetentionDays);
    return SUB2_EVENT_RETENTION_OPTIONS.includes(numericRetentionDays)
      ? numericRetentionDays
      : SUB2_DEFAULT_EVENT_RETENTION_DAYS;
  }

  function sub2PruneLocalEvents(
    rawEvents,
    retentionDays = SUB2_DEFAULT_EVENT_RETENTION_DAYS,
    now = Date.now(),
    maximumEvents = SUB2_LOCAL_EVENT_LIMIT,
  ) {
    const normalizedRetentionDays = sub2NormalizeEventRetentionDays(retentionDays);
    const oldestAllowedTimestamp = now - normalizedRetentionDays * SUB2_DAY_MS;
    const eventsById = new Map();
    for (const rawEvent of Array.isArray(rawEvents) ? rawEvents : []) {
      const normalizedEvent = sub2NormalizeLocalEvent(rawEvent);
      if (!normalizedEvent || normalizedEvent.occurredAt < oldestAllowedTimestamp) continue;
      const previousEvent = eventsById.get(normalizedEvent.id);
      if (!previousEvent || normalizedEvent.occurredAt >= previousEvent.occurredAt) {
        eventsById.set(normalizedEvent.id, normalizedEvent);
      }
    }
    const normalizedMaximumEvents = Number.isInteger(Number(maximumEvents)) && Number(maximumEvents) > 0
      ? Number(maximumEvents)
      : SUB2_LOCAL_EVENT_LIMIT;
    return [...eventsById.values()]
      .sort((leftEvent, rightEvent) => rightEvent.occurredAt - leftEvent.occurredAt)
      .slice(0, normalizedMaximumEvents);
  }

  function sub2MergeLocalEvents(
    existingEvents,
    incomingEvents,
    retentionDays = SUB2_DEFAULT_EVENT_RETENTION_DAYS,
    now = Date.now(),
  ) {
    return sub2PruneLocalEvents(
      (Array.isArray(incomingEvents) ? incomingEvents : []).concat(
        Array.isArray(existingEvents) ? existingEvents : [],
      ),
      retentionDays,
      now,
    );
  }

  function sub2BuildRequestStatusEvents(requestHistory, routingErrors) {
    const statusEvents = [];
    for (const requestItem of Array.isArray(requestHistory) ? requestHistory : []) {
      if (!sub2IsTrackedReliabilityStatus(requestItem?.statusCode)) continue;
      const eventType = sub2GetReliabilityEventType(requestItem.statusCode);
      const requestKey = sub2GetRequestHistoryKey(requestItem);
      statusEvents.push({
        id: `request-status:${requestKey}:${requestItem.statusCode}`,
        type: eventType,
        tone: requestItem.statusCode === 429 ? 'warn' : 'down',
        occurredAt: requestItem.createdAt,
        accountId: requestItem.accountId,
        groupId: requestItem.groupId,
        model: requestItem.model,
        requestId: requestItem.requestId,
        statusCode: requestItem.statusCode,
        title: `${requestItem.statusCode} 请求失败`,
        detail: requestItem.message || requestItem.phase || '最终请求返回受关注的错误状态。',
        source: 'request',
      });
    }
    for (const routingError of Array.isArray(routingErrors) ? routingErrors : []) {
      if (!sub2IsTrackedReliabilityStatus(routingError?.statusCode)) continue;
      const eventType = sub2GetReliabilityEventType(routingError.statusCode);
      const errorIdentity = routingError.id || [
        routingError.accountId,
        routingError.createdAt,
        routingError.requestId || routingError.clientRequestId || '',
      ].join(':');
      statusEvents.push({
        id: `upstream-status:${errorIdentity}:${routingError.statusCode}`,
        type: eventType,
        tone: routingError.statusCode === 429 ? 'warn' : 'down',
        occurredAt: routingError.createdAt,
        accountId: routingError.accountId,
        accountName: routingError.accountName,
        model: routingError.model,
        requestId: routingError.requestId || routingError.clientRequestId,
        statusCode: routingError.statusCode,
        title: `${routingError.statusCode} 上游${routingError.recovered ? '故障转移' : '错误'}`,
        detail: routingError.detail || '上游尝试返回受关注的错误状态。',
        source: 'upstream-error',
      });
    }
    return statusEvents;
  }

  function sub2NormalizeObservationSnapshot(rawSnapshot) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') return null;
    const capturedAt = Number(rawSnapshot.capturedAt);
    const normalizedAccounts = {};
    const rawAccounts = rawSnapshot.accounts && typeof rawSnapshot.accounts === 'object'
      ? rawSnapshot.accounts
      : {};
    for (const [rawAccountId, rawAccountState] of Object.entries(rawAccounts)) {
      const accountId = Number(rawAccountState?.accountId ?? rawAccountId);
      if (!Number.isInteger(accountId) || accountId <= 0) continue;
      const coolingUntil = Number(rawAccountState?.coolingUntil);
      normalizedAccounts[accountId] = {
        accountId,
        accountName: String(rawAccountState?.accountName || '').trim(),
        coolingUntil: Number.isFinite(coolingUntil) && coolingUntil > 0 ? coolingUntil : 0,
        coolingKind: String(rawAccountState?.coolingKind || '').trim(),
      };
    }
    const latestHitAccountId = Number(rawSnapshot.latestHit?.accountId);
    return {
      capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : 0,
      accounts: normalizedAccounts,
      latestHit: rawSnapshot.latestHit && typeof rawSnapshot.latestHit === 'object'
        ? {
          accountId: Number.isInteger(latestHitAccountId) && latestHitAccountId > 0
            ? latestHitAccountId
            : null,
          requestKey: String(rawSnapshot.latestHit.requestKey || '').trim(),
          createdAt: Number(rawSnapshot.latestHit.createdAt) || 0,
        }
        : null,
    };
  }

  function sub2BuildObservationSnapshot(accounts, recentRequest, now = Date.now()) {
    const accountStates = {};
    for (const account of Array.isArray(accounts) ? accounts : []) {
      const accountId = Number(account?.id);
      if (!Number.isInteger(accountId) || accountId <= 0) continue;
      const coolingCandidates = [
        { kind: '限流冷却', until: Date.parse(account?.rate_limit_reset_at) },
        { kind: '过载退避', until: Date.parse(account?.overload_until) },
        { kind: '临时熔断', until: Date.parse(account?.temp_unschedulable_until) },
      ].filter((candidate) => Number.isFinite(candidate.until) && candidate.until > now)
        .sort((leftCandidate, rightCandidate) => rightCandidate.until - leftCandidate.until);
      accountStates[accountId] = {
        accountId,
        accountName: String(account?.name || `账号 ${accountId}`).trim() || `账号 ${accountId}`,
        coolingUntil: coolingCandidates[0]?.until || 0,
        coolingKind: coolingCandidates[0]?.kind || '',
      };
    }
    return {
      capturedAt: now,
      accounts: accountStates,
      latestHit: recentRequest?.accountId
        ? {
          accountId: Number(recentRequest.accountId),
          requestKey: sub2GetRequestHistoryKey(recentRequest),
          createdAt: Number(recentRequest.createdAt) || now,
        }
        : null,
    };
  }

  function sub2BuildObservationTransitionEvents(previousSnapshot, currentSnapshot, now = Date.now()) {
    const previousState = sub2NormalizeObservationSnapshot(previousSnapshot);
    const currentState = sub2NormalizeObservationSnapshot(currentSnapshot);
    if (!previousState || !previousState.capturedAt || !currentState) return [];

    const transitionEvents = [];
    for (const [accountId, currentAccountState] of Object.entries(currentState.accounts)) {
      const previousAccountState = previousState.accounts[accountId] || null;
      if (!previousAccountState) continue;
      const coolingStarted = currentAccountState.coolingUntil > 0 && previousAccountState.coolingUntil <= 0;
      const coolingChanged = currentAccountState.coolingUntil > 0
        && previousAccountState.coolingUntil > 0
        && (currentAccountState.coolingUntil !== previousAccountState.coolingUntil
          || currentAccountState.coolingKind !== previousAccountState.coolingKind);
      const coolingEnded = currentAccountState.coolingUntil <= 0 && previousAccountState.coolingUntil > 0;
      if (coolingStarted || coolingChanged) {
        transitionEvents.push({
          id: `cooldown-start:${accountId}:${currentAccountState.coolingKind}:${currentAccountState.coolingUntil}`,
          type: 'cooldown',
          tone: 'warn',
          occurredAt: now,
          accountId: Number(accountId),
          accountName: currentAccountState.accountName,
          title: coolingChanged ? '冷却状态更新' : '进入冷却',
          detail: `${currentAccountState.coolingKind || '账号冷却'}，预计 ${sub2FormatUntil(currentAccountState.coolingUntil, now)}恢复。`,
          source: 'account-snapshot',
        });
      } else if (coolingEnded) {
        transitionEvents.push({
          id: `cooldown-end:${accountId}:${previousAccountState.coolingUntil}`,
          type: 'cooldown',
          tone: 'ok',
          occurredAt: now,
          accountId: Number(accountId),
          accountName: currentAccountState.accountName || previousAccountState.accountName,
          title: '冷却结束',
          detail: `${previousAccountState.coolingKind || '账号冷却'}已结束，当前快照未发现仍生效的冷却时间。`,
          source: 'account-snapshot',
        });
      }
    }

    const previousHit = previousState.latestHit;
    const currentHit = currentState.latestHit;
    const hitAccountChanged = previousHit?.accountId && currentHit?.accountId
      && previousHit.accountId !== currentHit.accountId
      && previousHit.requestKey !== currentHit.requestKey;
    if (hitAccountChanged) {
      const previousAccountName = previousState.accounts[previousHit.accountId]?.accountName || `账号 ${previousHit.accountId}`;
      const currentAccountName = currentState.accounts[currentHit.accountId]?.accountName || `账号 ${currentHit.accountId}`;
      transitionEvents.push({
        id: `hit-change:${currentHit.requestKey}:${previousHit.accountId}:${currentHit.accountId}`,
        type: 'hit-change',
        tone: 'info',
        occurredAt: currentHit.createdAt || now,
        accountId: currentHit.accountId,
        accountName: currentAccountName,
        requestId: currentHit.requestKey,
        title: '最近命中账号变化',
        detail: `${previousAccountName} -> ${currentAccountName}`,
        source: 'request-observation',
      });
    }
    return transitionEvents;
  }

  function sub2BuildReliabilitySnapshot(requestPayload, errorPayload, generatedAt = Date.now()) {
    const normalizedRequests = sub2NormalizeRequestHistory(requestPayload);
    const errorsAvailable = errorPayload !== null && errorPayload !== undefined;
    const requestCoverageComplete = sub2IsPaginatedPayloadComplete(requestPayload);
    const errorCoverageComplete = errorsAvailable && sub2IsPaginatedPayloadComplete(errorPayload);
    const annotatedRequests = sub2AnnotateRequestHistory(
      normalizedRequests,
      errorsAvailable ? errorPayload : null,
      errorCoverageComplete,
    );
    const routingErrors = errorsAvailable ? sub2NormalizeRoutingErrors(errorPayload) : [];
    const successCount = annotatedRequests.filter((requestItem) => requestItem.kind === 'success').length;
    const failureCount = annotatedRequests.filter((requestItem) => requestItem.kind === 'error').length;
    const failoverCount = annotatedRequests.filter((requestItem) => requestItem.routeStatus === 'failover').length;
    const trackedStatusCounts = { 403: 0, 429: 0, '5xx': 0 };
    for (const requestItem of annotatedRequests) {
      if (requestItem.statusCode === 403) trackedStatusCounts[403] += 1;
      else if (requestItem.statusCode === 429) trackedStatusCounts[429] += 1;
      else if (requestItem.statusCode >= 500 && requestItem.statusCode <= 599) trackedStatusCounts['5xx'] += 1;
    }
    return {
      available: true,
      generatedAt,
      requestCount: annotatedRequests.length,
      successCount,
      failureCount,
      successRate: annotatedRequests.length ? successCount / annotatedRequests.length * 100 : null,
      failoverCount,
      requestCoverageComplete,
      failoverCoverageComplete: requestCoverageComplete && errorCoverageComplete,
      trackedStatusCounts,
      requestHistory: annotatedRequests,
      routingErrors,
    };
  }

  // 审计条目统一形状，避免每条规则各自拼字段。severity 只有 critical / warning / info。
  function sub2CreateAuditFinding({
    id,
    severity,
    category,
    title,
    detail,
    evidence,
    accountIds = [],
    groupKey = '',
  }) {
    return {
      id: String(id || '').trim(),
      severity: SUB2_AUDIT_SEVERITY_RANK[severity] === undefined ? 'info' : severity,
      category: String(category || '').trim(),
      title: String(title || '').trim(),
      detail: String(detail || '').trim(),
      evidence: String(evidence || '当前快照').trim(),
      accountIds: accountIds.filter((accountId) => Number.isInteger(Number(accountId)) && Number(accountId) > 0)
        .map((accountId) => Number(accountId)),
      groupKey: String(groupKey || '').trim(),
    };
  }

  function sub2SortAuditFindings(findings) {
    return (Array.isArray(findings) ? findings.slice() : []).sort(
      (leftFinding, rightFinding) => SUB2_AUDIT_SEVERITY_RANK[rightFinding.severity]
        - SUB2_AUDIT_SEVERITY_RANK[leftFinding.severity]
        || leftFinding.category.localeCompare(rightFinding.category)
        || leftFinding.title.localeCompare(rightFinding.title),
    );
  }

  // 判断账号当前是否受限（冷却 / 摘出 / 停用 / 配额用尽），用于分组单点和主力受限检查。
  function sub2GetAccountRestrictionState(account, now = Date.now()) {
    const health = sub2ComputeHealth(account, now);
    const restrictionReasons = [];
    if (health.tone === 'down' || health.tone === 'paused') restrictionReasons.push(...health.reasons);

    if (sub2SupportsDailyQuota(account)) {
      const exceededQuota = ['total', 'daily', 'weekly']
        .map((dimension) => sub2GetQuotaUsageSnapshot(account, dimension, now))
        .find((quotaSnapshot) => quotaSnapshot.exceeded);
      if (exceededQuota) {
        const quotaLabels = { total: '总配额', daily: '日配额', weekly: '周配额' };
        restrictionReasons.push(
          `${quotaLabels[exceededQuota.dimension]}已用尽（${sub2FormatCost(exceededQuota.used)} / ${sub2FormatCost(exceededQuota.limit)}）`,
        );
      }
    }

    return {
      restricted: restrictionReasons.length > 0,
      tone: health.tone,
      reasons: restrictionReasons,
    };
  }

  function sub2GetAccountAuditLabel(account) {
    const accountId = Number(account?.id);
    const accountName = String(account?.name || '').trim();
    return accountName || (Number.isInteger(accountId) ? `账号 ${accountId}` : '未知账号');
  }

  // 分组单点故障：可调度成员过少，或全部成员当前受限。
  function sub2AuditGroupSinglePointRisks(accounts, groupsById = null, now = Date.now()) {
    const membersByGroupKey = new Map();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      for (const membership of sub2GetGroupMemberships(account, groupsById)) {
        if (!membersByGroupKey.has(membership.groupKey)) {
          membersByGroupKey.set(membership.groupKey, { membership, accounts: [] });
        }
        membersByGroupKey.get(membership.groupKey).accounts.push(account);
      }
    }

    const findings = [];
    for (const [groupKey, groupEntry] of membersByGroupKey) {
      const groupName = groupEntry.membership.name;
      const memberAccounts = groupEntry.accounts;
      const availableAccounts = memberAccounts.filter(
        (account) => !sub2GetAccountRestrictionState(account, now).restricted,
      );

      if (!availableAccounts.length) {
        findings.push(sub2CreateAuditFinding({
          id: `group-all-restricted:${groupKey}`,
          severity: 'critical',
          category: '分组单点故障',
          title: `分组「${groupName}」当前没有可用账号`,
          detail: `${memberAccounts.length} 个成员账号全部处于冷却、停用或配额用尽状态，该分组的请求当前只能失败或跨组降级。`,
          accountIds: memberAccounts.map((account) => account.id),
          groupKey,
        }));
        continue;
      }

      if (memberAccounts.length === 1) {
        findings.push(sub2CreateAuditFinding({
          id: `group-single-member:${groupKey}`,
          severity: 'warning',
          category: '分组单点故障',
          title: `分组「${groupName}」只有 1 个账号`,
          detail: `唯一成员为 ${sub2GetAccountAuditLabel(memberAccounts[0])}；该账号受限时分组内没有故障转移目标。`,
          evidence: '配置判断',
          accountIds: memberAccounts.map((account) => account.id),
          groupKey,
        }));
        continue;
      }

      if (availableAccounts.length === 1) {
        findings.push(sub2CreateAuditFinding({
          id: `group-single-available:${groupKey}`,
          severity: 'warning',
          category: '分组单点故障',
          title: `分组「${groupName}」仅剩 1 个可用账号`,
          detail: `${memberAccounts.length} 个成员中只有 ${sub2GetAccountAuditLabel(availableAccounts[0])} 当前可调度，其余账号受限。`,
          accountIds: memberAccounts.map((account) => account.id),
          groupKey,
        }));
      }
    }
    return findings;
  }

  // 平台 / 模型配置异常：只报能从账号响应直接读出的确定性问题。
  function sub2AuditPlatformAndModelConfig(accounts, groupsById = null, now = Date.now()) {
    const findings = [];
    for (const account of Array.isArray(accounts) ? accounts : []) {
      const accountId = Number(account?.id);
      const accountLabel = sub2GetAccountAuditLabel(account);
      const accountPlatform = String(account?.platform || '').trim();

      if (!accountPlatform) {
        findings.push(sub2CreateAuditFinding({
          id: `account-missing-platform:${accountId}`,
          severity: 'warning',
          category: '平台或模型配置',
          title: `${accountLabel} 未标注平台`,
          detail: '账号响应里没有 platform 字段，路由资格判断无法核对平台是否匹配请求。',
          evidence: '配置判断',
          accountIds: [accountId],
        }));
      }

      const memberships = sub2GetGroupMemberships(account, groupsById);
      const conflictingMembership = memberships.find(
        (membership) => membership.platform && accountPlatform && membership.platform !== accountPlatform,
      );
      if (conflictingMembership) {
        findings.push(sub2CreateAuditFinding({
          id: `account-platform-mismatch:${accountId}:${conflictingMembership.groupKey}`,
          severity: 'warning',
          category: '平台或模型配置',
          title: `${accountLabel} 与分组「${conflictingMembership.name}」平台不一致`,
          detail: `账号平台 ${accountPlatform}，分组平台 ${conflictingMembership.platform}；该分组的请求通常不会选中这个账号。`,
          evidence: '配置判断',
          accountIds: [accountId],
          groupKey: conflictingMembership.groupKey,
        }));
      }

      if (!memberships.length) {
        findings.push(sub2CreateAuditFinding({
          id: `account-ungrouped:${accountId}`,
          severity: 'info',
          category: '平台或模型配置',
          title: `${accountLabel} 未加入任何分组`,
          detail: '未分组账号只能被不限定分组的请求使用，不参与分组内的故障转移。',
          evidence: '配置判断',
          accountIds: [accountId],
        }));
      }

      const mappingState = sub2GetAccountModelMappingState(account);
      if (mappingState.known && !mappingState.patterns.length
        && (accountPlatform === 'grok' || accountPlatform === 'antigravity')) {
        findings.push(sub2CreateAuditFinding({
          id: `account-empty-model-mapping:${accountId}`,
          severity: 'info',
          category: '平台或模型配置',
          title: `${accountLabel} 模型映射为空`,
          detail: `${accountPlatform} 空映射由 sub2 注入平台默认模型，实际可用模型需要在模型抽屉里核对。`,
          evidence: '信息不足',
          accountIds: [accountId],
        }));
      }

      const expiresAt = sub2ParseTimestamp(account?.expires_at);
      if (Number.isFinite(expiresAt) && now >= expiresAt) {
        findings.push(sub2CreateAuditFinding({
          id: `account-expired:${accountId}`,
          severity: account?.auto_pause_on_expired === true ? 'critical' : 'warning',
          category: '平台或模型配置',
          title: `${accountLabel} 凭据已过期`,
          detail: account?.auto_pause_on_expired === true
            ? '账号已过期且启用了到期自动暂停，当前不会参与调度。'
            : '账号已过期但未启用自动暂停，仍可能被调度并直接失败。',
          accountIds: [accountId],
        }));
      }
    }
    return findings;
  }

  // 主力账号（有效优先级最小的一档）是否全部受限。按分组分别判断，未分组账号单独成一组。
  function sub2AuditPrimaryAccountAvailability(accounts, groupsById = null, now = Date.now()) {
    const scopes = new Map();
    const registerScopeAccount = (scopeKey, scopeName, account, priority) => {
      if (!scopes.has(scopeKey)) scopes.set(scopeKey, { scopeKey, scopeName, entries: [] });
      scopes.get(scopeKey).entries.push({ account, priority });
    };

    for (const account of Array.isArray(accounts) ? accounts : []) {
      const memberships = sub2GetGroupMemberships(account, groupsById);
      if (!memberships.length) {
        registerScopeAccount('ungrouped', '未分组账号', account, Number(account?.priority) || 0);
        continue;
      }
      for (const membership of memberships) {
        registerScopeAccount(
          membership.groupKey,
          `分组「${membership.name}」`,
          account,
          membership.priority === null ? Number(account?.priority) || 0 : membership.priority,
        );
      }
    }

    const findings = [];
    for (const scope of scopes.values()) {
      if (scope.entries.length < 2) continue;
      const bestPriority = Math.min(...scope.entries.map((entry) => entry.priority));
      const primaryEntries = scope.entries.filter((entry) => entry.priority === bestPriority);
      if (primaryEntries.length === scope.entries.length) continue;

      const restrictedPrimaryEntries = primaryEntries.filter(
        (entry) => sub2GetAccountRestrictionState(entry.account, now).restricted,
      );
      if (restrictedPrimaryEntries.length !== primaryEntries.length) continue;

      const fallbackEntries = scope.entries.filter(
        (entry) => entry.priority > bestPriority
          && !sub2GetAccountRestrictionState(entry.account, now).restricted,
      );
      findings.push(sub2CreateAuditFinding({
        id: `primary-accounts-restricted:${scope.scopeKey}`,
        severity: fallbackEntries.length ? 'warning' : 'critical',
        category: '主力账号受限',
        title: `${scope.scopeName} 优先级 ${bestPriority} 的主力账号全部受限`,
        detail: `${primaryEntries.map((entry) => sub2GetAccountAuditLabel(entry.account)).join('、')} 当前都不可调度；`
          + (fallbackEntries.length
            ? `流量会降级到 ${fallbackEntries.length} 个较低优先级账号。`
            : '该范围内没有可用的较低优先级账号承接流量。'),
        accountIds: primaryEntries.map((entry) => entry.account?.id),
        groupKey: scope.scopeKey === 'ungrouped' ? '' : scope.scopeKey,
      }));
    }
    return findings;
  }

  function sub2BuildConfigAudit(context = {}, now = Date.now()) {
    const accounts = Array.isArray(context.accounts) ? context.accounts : [];
    const groupsById = context.groupsById || null;
    const findings = sub2SortAuditFindings([
      ...sub2AuditGroupSinglePointRisks(accounts, groupsById, now),
      ...sub2AuditPlatformAndModelConfig(accounts, groupsById, now),
      ...sub2AuditPrimaryAccountAvailability(accounts, groupsById, now),
    ]);
    const severityCounts = { critical: 0, warning: 0, info: 0 };
    for (const finding of findings) severityCounts[finding.severity] += 1;
    return {
      generatedAt: now,
      accountCount: accounts.length,
      findings,
      severityCounts,
    };
  }

  // 只读容量建议：结合已配置容量、当前占用和近 24 小时真实请求里的 429 比例。
  // 不自动写入任何配置，仅给出方向和理由，实际调整仍由“容量”按钮人工完成。
  function sub2BuildCapacityAdvice(context = {}, now = Date.now()) {
    const accounts = Array.isArray(context.accounts) ? context.accounts : [];
    const concurrencyByAccountId = context.concurrencyByAccountId || null;
    const concurrencyRecordsByAccountId = context.concurrencyRecordsByAccountId || null;
    const reliabilitySnapshot = context.reliabilitySnapshot || null;
    const requestHistory = Array.isArray(reliabilitySnapshot?.requestHistory)
      ? reliabilitySnapshot.requestHistory
      : [];

    const trafficByAccountId = new Map();
    for (const requestItem of requestHistory) {
      const accountId = Number(requestItem?.accountId);
      if (!Number.isInteger(accountId) || accountId <= 0) continue;
      if (!trafficByAccountId.has(accountId)) {
        trafficByAccountId.set(accountId, { requestCount: 0, rateLimitedCount: 0, failureCount: 0 });
      }
      const traffic = trafficByAccountId.get(accountId);
      traffic.requestCount += 1;
      if (requestItem.statusCode === 429) traffic.rateLimitedCount += 1;
      if (requestItem.kind === 'error') traffic.failureCount += 1;
    }

    const historyAvailable = Boolean(reliabilitySnapshot);
    const historyComplete = reliabilitySnapshot?.requestCoverageComplete === true;
    const suggestions = [];
    for (const account of accounts) {
      const accountId = Number(account?.id);
      if (!Number.isInteger(accountId) || accountId <= 0) continue;
      const configuredCapacity = Number(account?.concurrency);
      const normalizedCapacity = Number.isFinite(configuredCapacity) ? configuredCapacity : 0;
      const concurrency = sub2ResolveAccountConcurrency(
        accountId,
        null,
        concurrencyByAccountId,
        concurrencyRecordsByAccountId,
      );
      const traffic = trafficByAccountId.get(accountId) || { requestCount: 0, rateLimitedCount: 0, failureCount: 0 };
      const rateLimitRatio = traffic.requestCount > 0 ? traffic.rateLimitedCount / traffic.requestCount : 0;
      const currentInUse = Number.isFinite(concurrency?.currentInUse) ? concurrency.currentInUse : null;
      const waitingInQueue = Number.isFinite(concurrency?.waitingInQueue) ? concurrency.waitingInQueue : 0;
      const utilization = normalizedCapacity > 0 && currentInUse !== null
        ? currentInUse / normalizedCapacity
        : null;

      const reasons = [];
      let direction = 'keep';
      let confidence = historyAvailable && historyComplete ? '当前快照' : '信息不足';

      if (!historyAvailable) {
        reasons.push(`未读取近 ${SUB2_CAPACITY_ADVICE_WINDOW_HOURS} 小时请求，建议仅基于当前容量快照。`);
      } else if (!traffic.requestCount) {
        reasons.push(`近 ${SUB2_CAPACITY_ADVICE_WINDOW_HOURS} 小时没有读取到该账号的请求记录。`);
        confidence = '信息不足';
      } else {
        reasons.push(
          `近 ${SUB2_CAPACITY_ADVICE_WINDOW_HOURS} 小时读取到 ${traffic.requestCount} 条请求，`
          + `其中 429 限流 ${traffic.rateLimitedCount} 条（${(rateLimitRatio * 100).toFixed(1)}%）。`,
        );
      }

      if (traffic.requestCount > 0 && rateLimitRatio >= SUB2_CAPACITY_RATE_LIMIT_RATIO) {
        direction = 'decrease';
        reasons.push('限流占比偏高，先下调容量或降低优先级通常比继续加压更快恢复。');
      } else if (utilization !== null && utilization >= SUB2_CAPACITY_HIGH_LOAD_RATIO) {
        direction = 'increase';
        reasons.push(`当前占用 ${currentInUse} / ${normalizedCapacity}，已接近配置上限。`);
        if (waitingInQueue > 0) reasons.push(`同时有 ${waitingInQueue} 个请求在排队。`);
      } else if (waitingInQueue > 0) {
        direction = 'increase';
        reasons.push(`存在 ${waitingInQueue} 个排队请求，说明容量在高峰期不足。`);
      } else if (normalizedCapacity <= 0) {
        direction = 'review';
        reasons.push('账号没有有效的并发容量配置，调度行为取决于 sub2 默认值。');
        confidence = '配置判断';
      } else {
        reasons.push('当前占用和限流都没有触及阈值，维持现有容量即可。');
      }

      if (context.concurrencyAvailable === false) {
        reasons.push('容量接口不可用，占用数据缺失。');
        confidence = '信息不足';
      } else if (context.concurrencyEnabled === false) {
        reasons.push('sub2 并发统计未启用，占用数据缺失。');
        confidence = '信息不足';
      } else if (!concurrency) {
        reasons.push('容量接口未返回该账号记录，当前占用未知。');
        confidence = '信息不足';
      }

      if (historyAvailable && !historyComplete) {
        reasons.push('请求记录超过单次读取上限，比例只代表已读取样本。');
        confidence = '信息不足';
      }

      suggestions.push({
        accountId,
        accountName: sub2GetAccountAuditLabel(account),
        configuredCapacity: normalizedCapacity,
        currentInUse,
        waitingInQueue,
        requestCount: traffic.requestCount,
        rateLimitedCount: traffic.rateLimitedCount,
        rateLimitRatio,
        direction,
        confidence,
        reasons,
      });
    }

    const directionRank = { decrease: 0, increase: 1, review: 2, keep: 3 };
    suggestions.sort((leftSuggestion, rightSuggestion) => directionRank[leftSuggestion.direction]
      - directionRank[rightSuggestion.direction]
      || rightSuggestion.rateLimitRatio - leftSuggestion.rateLimitRatio
      || leftSuggestion.accountName.localeCompare(rightSuggestion.accountName));

    return {
      generatedAt: now,
      historyAvailable,
      historyComplete,
      windowHours: SUB2_CAPACITY_ADVICE_WINDOW_HOURS,
      suggestions,
    };
  }

  function sub2ParseUpstreamErrorEvents(detailPayload) {
    const rawEvents = detailPayload?.upstream_errors;
    if (Array.isArray(rawEvents)) return rawEvents;
    if (typeof rawEvents !== 'string' || !rawEvents.trim()) return [];
    try {
      const parsedEvents = JSON.parse(rawEvents);
      return Array.isArray(parsedEvents) ? parsedEvents : [];
    } catch {
      return [];
    }
  }

  function sub2NormalizeRouteEvent(rawEvent, fallback = {}, sequence = 0) {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const accountId = Number(rawEvent.account_id ?? fallback.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) return null;

    let occurredAt = Number(rawEvent.at_unix_ms);
    if (Number.isFinite(occurredAt) && occurredAt > 0 && occurredAt < 100000000000) {
      occurredAt *= 1000;
    }
    if (!Number.isFinite(occurredAt) || occurredAt <= 0) {
      occurredAt = Number(fallback.createdAt) || 0;
    }

    const statusCode = sub2ExtractRoutingStatusCode(rawEvent) ?? fallback.statusCode ?? null;
    const kind = String(rawEvent.kind || fallback.kind || 'upstream_error').trim().toLocaleLowerCase();
    const reason = String(rawEvent.reason || rawEvent.message || rawEvent.detail || fallback.detail || '').trim();
    return {
      type: 'failure',
      accountId,
      accountName: String(rawEvent.account_name || fallback.accountName || '').trim(),
      occurredAt,
      statusCode,
      platform: String(rawEvent.platform || fallback.platform || '').trim(),
      kind,
      stage: String(rawEvent.stage || '').trim(),
      scope: String(rawEvent.scope || '').trim(),
      reason,
      sequence,
      source: 'detail',
    };
  }

  function sub2BuildRouteChain(
    recentRequest,
    correlatedErrors = [],
    detailPayloads = [],
    detailsComplete = true,
  ) {
    const detailedEvents = [];
    const detailErrorIdsWithEvents = new Set();
    let sequence = 0;
    for (const detailPayload of Array.isArray(detailPayloads) ? detailPayloads : []) {
      const parsedEvents = sub2ParseUpstreamErrorEvents(detailPayload);
      const detailErrorId = Number(detailPayload?.id);
      let normalizedEventCount = 0;
      for (const rawEvent of parsedEvents) {
        const normalizedEvent = sub2NormalizeRouteEvent(rawEvent, {
          accountId: detailPayload?.account_id,
          accountName: detailPayload?.account_name,
          createdAt: Date.parse(detailPayload?.created_at),
          statusCode: sub2ExtractRoutingStatusCode(detailPayload),
          platform: detailPayload?.platform,
        }, sequence++);
        if (normalizedEvent) {
          detailedEvents.push(normalizedEvent);
          normalizedEventCount += 1;
        }
      }
      if (normalizedEventCount > 0 && Number.isInteger(detailErrorId) && detailErrorId > 0) {
        detailErrorIdsWithEvents.add(detailErrorId);
      }
    }

    const uniqueEvents = [];
    const seenEventKeys = new Set();
    for (const routeEvent of detailedEvents) {
      const eventKey = [
        routeEvent.accountId,
        routeEvent.occurredAt,
        routeEvent.statusCode || '',
        routeEvent.kind,
        routeEvent.reason,
      ].join('|');
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);
      uniqueEvents.push(routeEvent);
    }

    // 为详情未覆盖的关联账号保留列表摘要。部分详情超时或被截断时，不能因为
    // 另一条详情成功就把已知失败账号从链路中删除。
    let summaryFallbackCount = 0;
    let unresolvedRecoveredSummaryCount = 0;
    for (const routingError of Array.isArray(correlatedErrors) ? correlatedErrors : []) {
      const errorCoveredByDetails = routingError.id && detailErrorIdsWithEvents.has(routingError.id);
      if (routingError.recovered) {
        // recovered 行是在最终请求成功后写入的，account_id 可能是最终成功账号；
        // 真实失败账号只存在 upstream_errors 详情中，不能用摘要账号伪造失败跳点。
        if (!errorCoveredByDetails) unresolvedRecoveredSummaryCount += 1;
        continue;
      }
      const accountCoveredByDetails = uniqueEvents.some(
        (routeEvent) => routeEvent.accountId === routingError.accountId,
      );
      if (!errorCoveredByDetails && !accountCoveredByDetails) {
        uniqueEvents.push({
          type: 'failure',
          accountId: routingError.accountId,
          accountName: routingError.accountName,
          occurredAt: routingError.createdAt,
          statusCode: routingError.statusCode,
          platform: '',
          kind: routingError.recovered ? 'recovered_error' : 'upstream_error',
          stage: '',
          scope: '',
          reason: routingError.detail,
          sequence: sequence++,
          source: 'summary',
        });
        summaryFallbackCount += 1;
      }
    }

    if (recentRequest?.kind === 'error' && recentRequest.accountId) {
      uniqueEvents.push({
        type: 'failure',
        accountId: recentRequest.accountId,
        accountName: '',
        occurredAt: recentRequest.createdAt,
        statusCode: recentRequest.statusCode,
        platform: recentRequest.platform,
        kind: 'request_error',
        stage: recentRequest.phase,
        scope: '',
        reason: recentRequest.message || '请求最终失败',
        sequence: sequence++,
        source: 'request',
      });
    } else if (recentRequest) {
      uniqueEvents.push({
        type: 'success',
        accountId: recentRequest.accountId,
        accountName: '',
        occurredAt: recentRequest.createdAt,
        statusCode: null,
        platform: recentRequest.platform,
        kind: 'success',
        stage: '',
        scope: '',
        reason: recentRequest.model ? `成功响应 · ${recentRequest.model}` : '成功响应',
        sequence: sequence++,
        source: 'request',
      });
    }

    uniqueEvents.sort((leftEvent, rightEvent) => {
      if (leftEvent.type !== rightEvent.type) return leftEvent.type === 'success' ? 1 : -1;
      const leftTimestamp = Number(leftEvent.occurredAt) || 0;
      const rightTimestamp = Number(rightEvent.occurredAt) || 0;
      return leftTimestamp - rightTimestamp || leftEvent.sequence - rightEvent.sequence;
    });

    return {
      events: uniqueEvents,
      detailLevel: detailedEvents.length
        ? detailsComplete && summaryFallbackCount === 0 && unresolvedRecoveredSummaryCount === 0
          ? 'detailed'
          : 'partial'
        : correlatedErrors.length
          ? 'summary'
          : recentRequest?.kind === 'error' ? 'request-error' : 'success-only',
      unresolvedRecoveredSummaryCount,
    };
  }

  function sub2BuildRecentRoutingErrorIndex(payload, recentRequest = null) {
    const errorByAccountId = new Map();
    const recentCorrelationId = sub2NormalizeCorrelationId(recentRequest?.requestId);
    for (const errorItem of sub2GetPaginatedItems(payload)) {
      const normalizedError = sub2NormalizeRoutingError(errorItem);
      if (!normalizedError) continue;
      // recovered 摘要行的 account_id 可能是最终成功账号，不能直接归因为该账号失败。
      // 真实失败账号会在随后读取的 routeChain.upstream_errors 详情中回填。
      if (normalizedError.recovered) continue;
      normalizedError.correlated = Boolean(recentCorrelationId
        && sub2RoutingErrorMatchesRequest(normalizedError, recentRequest));
      const previousError = errorByAccountId.get(normalizedError.accountId);
      const replacesPrevious = !previousError
        || normalizedError.createdAt > previousError.createdAt
        || (normalizedError.createdAt === previousError.createdAt
          && normalizedError.correlated
          && !previousError.correlated);
      if (replacesPrevious) {
        errorByAccountId.set(normalizedError.accountId, normalizedError);
      }
    }
    return errorByAccountId;
  }

  function sub2MergeRouteFailuresIntoErrorIndex(errorByAccountId, routeChain, recentRequest = null) {
    const mergedIndex = errorByAccountId instanceof Map ? errorByAccountId : new Map();
    for (const routeEvent of Array.isArray(routeChain?.events) ? routeChain.events : []) {
      if (routeEvent.type !== 'failure') continue;
      const accountId = Number(routeEvent.accountId);
      if (!Number.isInteger(accountId) || accountId <= 0) continue;
      const routingError = {
        id: null,
        accountId,
        accountName: String(routeEvent.accountName || '').trim(),
        createdAt: Number(routeEvent.occurredAt) || Number(recentRequest?.createdAt) || 0,
        statusCode: routeEvent.statusCode || null,
        recovered: true,
        detail: String(routeEvent.reason || '').trim(),
        model: String(recentRequest?.model || '').trim(),
        requestId: String(recentRequest?.requestId || '').trim(),
        clientRequestId: '',
        correlated: true,
      };
      const previousError = mergedIndex.get(accountId);
      if (!previousError || routingError.createdAt >= previousError.createdAt) {
        mergedIndex.set(accountId, routingError);
      }
    }
    return mergedIndex;
  }

  function sub2ResolveLatestHit(accounts, recentRequest, allowLastUsedFallback = true) {
    const accountList = Array.isArray(accounts) ? accounts : [];
    if (recentRequest) {
      const matchedAccount = accountList.find((account) => Number(account?.id) === recentRequest.accountId);
      if (matchedAccount) {
        return {
          ...recentRequest,
          accountName: String(matchedAccount.name || `账号 ${recentRequest.accountId}`).trim(),
          priority: Number(matchedAccount.priority) || 0,
        };
      }
      // Ops 已给出明确账号，但当前列表没有该账号时，不能把另一个账号误标为最近命中。
      return null;
    }

    if (!allowLastUsedFallback) return null;

    let latestHit = null;
    for (const account of accountList) {
      const accountId = Number(account?.id);
      const createdAt = Date.parse(account?.last_used_at);
      if (!Number.isInteger(accountId) || accountId <= 0 || !Number.isFinite(createdAt)) continue;
      if (!latestHit || createdAt > latestHit.createdAt) {
        latestHit = {
          accountId,
          createdAt,
          groupId: null,
          platform: String(account.platform || '').trim(),
          model: '',
          requestId: '',
          source: 'last_used_at',
          accountName: String(account.name || `账号 ${accountId}`).trim(),
          priority: Number(account.priority) || 0,
        };
      }
    }
    return latestHit;
  }

  function sub2FormatRoutingError(errorInfo, now = Date.now()) {
    if (!errorInfo) return '';
    const statusLabel = errorInfo.statusCode ? String(errorInfo.statusCode) : '上游状态码未知';
    const detail = String(errorInfo.detail || '').trim();
    const shortDetail = detail.length > 90 ? `${detail.slice(0, 87)}...` : detail;
    const ageLabel = sub2FormatRelative(errorInfo.createdAt, now);
    return `${statusLabel}${shortDetail ? ` · ${shortDetail}` : ''} · ${ageLabel}`;
  }

  function sub2BuildRoutingExplanation(account, context = {}, now = Date.now()) {
    const accountId = Number(account?.id);
    const latestHit = context.latestHit || null;
    const recentError = context.recentError || null;
    const errorIsRecent = recentError
      && now - recentError.createdAt >= 0
      && now - recentError.createdAt <= SUB2_ROUTING_LOOKBACK_MS;

    if (errorIsRecent) {
      return {
        tone: recentError.recovered ? 'verified' : 'down',
        evidence: '已证实',
        text: `${recentError.correlated
          ? (recentError.recovered ? '最近请求真实降级' : '最近请求上游失败')
          : (recentError.recovered ? '近期真实降级（未与最近请求关联）' : '近期上游失败（未与最近请求关联）')
        }：${sub2FormatRoutingError(recentError, now)}`,
      };
    }

    if (latestHit && accountId === latestHit.accountId) {
      const modelLabel = latestHit.model ? ` · ${latestHit.model}` : '';
      return {
        tone: 'hit',
        evidence: '已证实',
        text: `最近成功命中${modelLabel} · ${sub2FormatRelative(latestHit.createdAt, now)}`,
      };
    }

    if (!latestHit) return null;
    const candidatePriority = sub2GetEffectivePriority(account, latestHit.groupId, context.groupsById);
    const hitPriority = Number.isFinite(context.latestHitEffectivePriority)
      ? context.latestHitEffectivePriority
      : latestHit.priority;
    if (candidatePriority >= hitPriority) return null;

    const eligibility = sub2EvaluateCandidateEligibility(account, {
      recentRequest: latestHit,
      groupsById: context.groupsById,
      routeChain: context.routeChain,
      concurrency: context.concurrency,
      concurrencyAvailable: context.concurrencyAvailable,
      concurrencyEnabled: context.concurrencyEnabled,
      savedModelState: context.savedModelState,
    }, now);
    const eligibilityText = eligibility.reasons.join('；');
    if (eligibility.status === 'attempted') {
      return { tone: 'verified', evidence: '已证实', text: eligibilityText };
    }
    if (eligibility.status === 'eligible' && context.errorsAvailable === false) {
      return {
        tone: 'inferred',
        evidence: '信息不足',
        text: `${eligibilityText}；运维故障明细不可用`,
      };
    }
    return {
      tone: 'inferred',
      evidence: eligibility.evidence,
      text: eligibilityText,
    };
  }

  function sub2NormalizeModels(payload) {
    const candidateCollections = [
      payload,
      payload?.models,
      payload?.items,
      payload?.list,
      payload?.data,
    ];
    const sourceModels = candidateCollections.find((candidate) => Array.isArray(candidate)) || [];
    const normalizedModels = [];
    const seenModelIds = new Set();

    for (const sourceModel of sourceModels) {
      const modelId = String(
        typeof sourceModel === 'string'
          ? sourceModel
          : sourceModel?.id ?? sourceModel?.model ?? sourceModel?.name ?? '',
      ).trim();
      if (!modelId || seenModelIds.has(modelId)) continue;
      seenModelIds.add(modelId);
      normalizedModels.push({
        id: modelId,
        displayName: String(sourceModel?.display_name ?? sourceModel?.displayName ?? modelId).trim() || modelId,
        owner: String(sourceModel?.owned_by ?? sourceModel?.owner ?? '').trim(),
        type: String(sourceModel?.type ?? sourceModel?.object ?? '').trim(),
      });
    }

    return normalizedModels.sort((leftModel, rightModel) => leftModel.id.localeCompare(rightModel.id));
  }

  function sub2ModelPatternMatches(pattern, requestedModel) {
    const normalizedPattern = String(pattern || '');
    const normalizedRequestedModel = String(requestedModel || '');
    if (normalizedPattern.endsWith('*')) {
      return normalizedRequestedModel.startsWith(normalizedPattern.slice(0, -1));
    }
    return normalizedPattern === normalizedRequestedModel;
  }

  function sub2NormalizeRequestedModelForLookup(platform, requestedModel) {
    const trimmedModel = String(requestedModel || '').trim();
    if ((platform === 'gemini' || platform === 'antigravity')
      && trimmedModel === 'gemini-3.1-pro-preview-customtools') {
      return 'gemini-3.1-pro-preview';
    }
    return trimmedModel;
  }

  function sub2GetModelLookupCandidates(platform, requestedModel) {
    const rawModel = String(requestedModel || '');
    const normalizedModel = sub2NormalizeRequestedModelForLookup(platform, rawModel);
    return rawModel === normalizedModel ? [rawModel] : [rawModel, normalizedModel];
  }

  function sub2GetAccountModelMappingState(account) {
    const credentials = account?.credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return { known: false, patterns: [] };
    }

    const rawMapping = credentials.model_mapping;
    if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
      return { known: true, patterns: [] };
    }

    const patterns = Object.entries(rawMapping)
      .filter(([, targetModel]) => typeof targetModel === 'string')
      .map(([sourceModel]) => sourceModel);
    return { known: true, patterns };
  }

  function sub2IsOpenAIOAuthForeignModel(account, requestedModel) {
    const platform = String(account?.platform || '').trim();
    const accountType = String(account?.type || '').trim();
    const currentPassthroughValue = account?.extra?.openai_passthrough;
    const legacyPassthroughValue = account?.extra?.openai_oauth_passthrough;
    const passthroughEnabled = typeof currentPassthroughValue === 'boolean'
      ? currentPassthroughValue
      : legacyPassthroughValue === true;
    if (platform !== 'openai' || accountType !== 'oauth' || passthroughEnabled) return false;

    const finalModelSegment = String(requestedModel || '').trim().split('/').pop().toLocaleLowerCase();
    return SUB2_OPENAI_OAUTH_FOREIGN_MODEL_PREFIXES.some(
      (modelPrefix) => finalModelSegment.startsWith(modelPrefix),
    );
  }

  function sub2EvaluateSavedModelEvidence(savedModelState, lookupCandidates, requestedModel) {
    if (savedModelState?.status === 'loaded') {
      const savedModels = Array.isArray(savedModelState.models) ? savedModelState.models : [];
      const matchingSavedModel = savedModels.find((savedModel) => {
        const savedModelId = String(savedModel?.id ?? savedModel ?? '');
        return lookupCandidates.some(
          (lookupModel) => sub2ModelPatternMatches(savedModelId, lookupModel),
        );
      });
      if (matchingSavedModel) {
        const savedModelId = String(matchingSavedModel?.id ?? matchingSavedModel);
        return {
          status: 'supported',
          evidence: '配置判断',
          reason: `sub2 保存模型 ${savedModelId} 支持 ${requestedModel}`,
          checkNeeded: false,
        };
      }
      return {
        status: 'unknown',
        evidence: '信息不足',
        reason: savedModels.length
          ? `sub2 保存的 ${savedModels.length} 个模型中未找到 ${requestedModel}；保存列表缺失不能替代调度器的模型映射判断`
          : 'sub2 保存模型为空，无法判断模型资格',
        checkNeeded: false,
      };
    }

    if (savedModelState?.status === 'error') {
      return {
        status: 'unknown',
        evidence: '信息不足',
        reason: '读取 sub2 保存模型失败，模型资格未知',
        checkNeeded: true,
      };
    }
    if (savedModelState?.status === 'loading') {
      return {
        status: 'unknown',
        evidence: '信息不足',
        reason: '正在读取 sub2 保存模型',
        checkNeeded: true,
      };
    }
    return null;
  }

  function sub2EvaluateModelSupport(account, requestedModel, savedModelState = null) {
    const platform = String(account?.platform || '').trim();
    const lookupCandidates = sub2GetModelLookupCandidates(platform, requestedModel);
    const mappingState = sub2GetAccountModelMappingState(account);

    if (mappingState.known && mappingState.patterns.length) {
      const matchingPattern = mappingState.patterns.find(
        (modelPattern) => lookupCandidates.some(
          (lookupModel) => sub2ModelPatternMatches(modelPattern, lookupModel),
        ),
      );
      if (matchingPattern) {
        return {
          status: 'supported',
          evidence: '配置判断',
          reason: matchingPattern === requestedModel
            ? `账号模型映射包含 ${requestedModel}`
            : `账号模型映射 ${matchingPattern} 支持 ${requestedModel}`,
          checkNeeded: false,
        };
      }
      if (platform === 'antigravity') {
        return sub2EvaluateSavedModelEvidence(savedModelState, lookupCandidates, requestedModel) || {
          status: 'unknown',
          evidence: '信息不足',
          reason: 'Antigravity 会在原始配置上补充默认透传和模型别名，需核对 sub2 有效模型列表',
          checkNeeded: true,
        };
      }
      return {
        status: 'unsupported',
        evidence: '配置判断',
        reason: `账号模型映射不支持 ${requestedModel}`,
        checkNeeded: false,
      };
    }

    if (mappingState.known) {
      if (platform === 'grok' || platform === 'antigravity') {
        return sub2EvaluateSavedModelEvidence(savedModelState, lookupCandidates, requestedModel) || {
          status: 'unknown',
          evidence: '信息不足',
          reason: `${platform === 'grok' ? 'Grok' : 'Antigravity'} 空映射会由 sub2 注入平台默认模型，需核对 sub2 有效模型列表`,
          checkNeeded: true,
        };
      }
      if (sub2IsOpenAIOAuthForeignModel(account, requestedModel)) {
        return {
          status: 'unsupported',
          evidence: '配置判断',
          reason: `空模型映射的 OpenAI OAuth 账号会排除其他厂商模型 ${requestedModel}`,
          checkNeeded: false,
        };
      }
      return {
        status: 'supported',
        evidence: '配置判断',
        reason: '账号未配置模型映射，sub2 按官方规则允许该模型',
        checkNeeded: false,
      };
    }

    return sub2EvaluateSavedModelEvidence(savedModelState, lookupCandidates, requestedModel) || {
      status: 'unknown',
      evidence: '信息不足',
      reason: `账号响应未暴露模型映射，尚未核对 sub2 保存模型是否包含 ${requestedModel}`,
      checkNeeded: true,
    };
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

  function sub2NormalizeOptionalPriority(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const numericPriority = Number(value);
    return Number.isFinite(numericPriority) ? numericPriority : null;
  }

  function sub2BuildGroupIndex(groups) {
    const groupsById = new Map();
    for (const group of Array.isArray(groups) ? groups : []) {
      const numericGroupId = Number(group?.id);
      if (!Number.isInteger(numericGroupId) || numericGroupId <= 0) continue;
      groupsById.set(numericGroupId, group);
    }
    return groupsById;
  }

  function sub2GetIndexedGroup(groupsById, groupId) {
    if (!groupsById || groupId === null) return {};
    if (typeof groupsById.get === 'function') {
      return groupsById.get(groupId) || groupsById.get(String(groupId)) || {};
    }
    return groupsById[groupId] || groupsById[String(groupId)] || {};
  }

  function sub2GetGroupMemberships(account, groupsById = null) {
    const accountGroups = Array.isArray(account?.account_groups) ? account.account_groups : [];
    const memberships = [];
    const seenGroupKeys = new Set();

    for (const accountGroup of accountGroups) {
      const inlineGroup = accountGroup?.group && typeof accountGroup.group === 'object' ? accountGroup.group : {};
      const numericGroupId = Number(accountGroup?.group_id ?? inlineGroup.id);
      const groupId = Number.isInteger(numericGroupId) && numericGroupId > 0 ? numericGroupId : null;
      const indexedGroup = sub2GetIndexedGroup(groupsById, groupId);
      const groupName = String(inlineGroup.name || indexedGroup.name || (groupId ? `分组 ${groupId}` : '未命名分组')).trim();
      const groupKey = groupId ? `id:${groupId}` : `name:${groupName.toLocaleLowerCase()}`;
      if (seenGroupKeys.has(groupKey)) continue;
      seenGroupKeys.add(groupKey);

      memberships.push({
        groupId,
        groupKey,
        name: groupName,
        platform: String(inlineGroup.platform || indexedGroup.platform || account?.platform || '').trim(),
        priority: sub2NormalizeOptionalPriority(accountGroup?.priority),
        status: String(inlineGroup.status || indexedGroup.status || '').trim(),
      });
    }

    // 兼容只返回 groups、没有 account_groups 的旧版接口。
    if (!memberships.length && Array.isArray(account?.groups)) {
      for (const group of account.groups) {
        const numericGroupId = Number(group?.id);
        const groupId = Number.isInteger(numericGroupId) && numericGroupId > 0 ? numericGroupId : null;
        const indexedGroup = sub2GetIndexedGroup(groupsById, groupId);
        const groupName = String(group?.name || indexedGroup.name || (groupId ? `分组 ${groupId}` : '未命名分组')).trim();
        const groupKey = groupId ? `id:${groupId}` : `name:${groupName.toLocaleLowerCase()}`;
        if (seenGroupKeys.has(groupKey)) continue;
        seenGroupKeys.add(groupKey);
        memberships.push({
          groupId,
          groupKey,
          name: groupName,
          platform: String(group?.platform || indexedGroup.platform || account?.platform || '').trim(),
          priority: null,
          status: String(group?.status || indexedGroup.status || '').trim(),
        });
      }
    }

    // 兼容只返回 group_ids 的接口；分组名称由 /admin/groups 的只读结果补全。
    if (!memberships.length && Array.isArray(account?.group_ids)) {
      for (const rawGroupId of account.group_ids) {
        const numericGroupId = Number(rawGroupId);
        if (!Number.isInteger(numericGroupId) || numericGroupId <= 0) continue;
        const indexedGroup = sub2GetIndexedGroup(groupsById, numericGroupId);
        const groupKey = `id:${numericGroupId}`;
        if (seenGroupKeys.has(groupKey)) continue;
        seenGroupKeys.add(groupKey);
        memberships.push({
          groupId: numericGroupId,
          groupKey,
          name: String(indexedGroup.name || `分组 ${numericGroupId}`).trim(),
          platform: String(indexedGroup.platform || account?.platform || '').trim(),
          priority: null,
          status: String(indexedGroup.status || '').trim(),
        });
      }
    }

    return memberships;
  }

  function sub2GetEffectivePriority(account, requestGroupId = null, groupsById = null) {
    const accountPriority = Number(account?.priority);
    const normalizedAccountPriority = Number.isFinite(accountPriority) ? accountPriority : 0;
    if (!requestGroupId) return normalizedAccountPriority;
    const matchingMembership = sub2GetGroupMemberships(account, groupsById)
      .find((membership) => membership.groupId === requestGroupId);
    return matchingMembership?.priority === null || matchingMembership?.priority === undefined
      ? normalizedAccountPriority
      : matchingMembership.priority;
  }

  function sub2FindAccountRouteFailure(accountId, routeChain) {
    const routeEvents = Array.isArray(routeChain?.events) ? routeChain.events : [];
    return routeEvents.find((routeEvent) => routeEvent.type === 'failure'
      && Number(routeEvent.accountId) === Number(accountId)) || null;
  }

  function sub2DescribeRouteEvent(routeEvent) {
    if (!routeEvent) return '';
    if (routeEvent.type === 'success') return routeEvent.reason || '成功响应';
    const statusLabel = routeEvent.statusCode ? String(routeEvent.statusCode) : '状态码未知';
    const rawReason = String(routeEvent.reason || '').trim();
    const shortReason = rawReason.length > 140 ? `${rawReason.slice(0, 137)}...` : rawReason;
    return `${statusLabel}${shortReason ? ` · ${shortReason}` : ''}`;
  }

  function sub2EvaluateCandidateEligibility(account, context = {}, now = Date.now()) {
    const recentRequest = context.recentRequest || context.latestHit || null;
    const accountId = Number(account?.id);
    const effectivePriority = sub2GetEffectivePriority(account, recentRequest?.groupId, context.groupsById);
    const result = {
      status: 'unknown',
      tone: 'unknown',
      evidence: '信息不足',
      effectivePriority,
      reasons: [],
      modelCheckNeeded: false,
    };
    let modelCheckUnknown = false;

    if (!recentRequest) {
      result.reasons.push('最近 30 分钟没有可分析的成功请求');
      return result;
    }

    if (accountId === Number(recentRequest.accountId)) {
      result.status = 'hit';
      result.tone = 'hit';
      result.evidence = '已证实';
      result.reasons.push('最近请求最终由该账号成功响应');
      return result;
    }

    const actualRouteFailure = sub2FindAccountRouteFailure(accountId, context.routeChain);
    if (actualRouteFailure) {
      result.status = 'attempted';
      result.tone = 'attempted';
      result.evidence = '已证实';
      result.reasons.push(`最近请求实际尝试后失败：${sub2DescribeRouteEvent(actualRouteFailure)}`);
      return result;
    }

    const accountPlatform = String(account?.platform || '').trim();
    if (recentRequest.platform && accountPlatform !== recentRequest.platform) {
      result.status = 'excluded';
      result.tone = 'excluded';
      result.evidence = '配置判断';
      result.reasons.push(`平台 ${accountPlatform || '未知'} 与请求平台 ${recentRequest.platform} 不同`);
      return result;
    }

    let matchingMembership = null;
    if (recentRequest.groupId) {
      matchingMembership = sub2GetGroupMemberships(account, context.groupsById)
        .find((membership) => membership.groupId === recentRequest.groupId) || null;
      if (!matchingMembership) {
        const requestGroup = sub2GetIndexedGroup(context.groupsById, recentRequest.groupId);
        const requestGroupName = String(requestGroup?.name || `分组 ${recentRequest.groupId}`).trim();
        result.status = 'excluded';
        result.tone = 'excluded';
        result.evidence = '配置判断';
        result.reasons.push(`当前不属于请求分组「${requestGroupName}」`);
        return result;
      }
      if (matchingMembership.status && matchingMembership.status !== 'active') {
        result.status = 'excluded';
        result.tone = 'excluded';
        result.evidence = '当前快照';
        result.reasons.push(`请求分组当前状态为 ${matchingMembership.status}`);
        return result;
      }
    }

    const expiresAt = sub2ParseTimestamp(account?.expires_at);
    if (account?.auto_pause_on_expired === true && Number.isFinite(expiresAt) && now >= expiresAt) {
      result.status = 'constrained';
      result.tone = 'constrained';
      result.evidence = '当前快照';
      result.reasons.push('账号已过期，且启用了到期自动暂停');
      return result;
    }

    const health = sub2ComputeHealth(account, now);
    if (health.tone === 'down' || health.tone === 'paused') {
      result.status = 'constrained';
      result.tone = 'constrained';
      result.evidence = '当前快照';
      result.reasons.push(`账号当前不可正常调度：${health.reasons.join('；')}`);
      result.reasons.push('这是当前状态，不等于请求发生时的历史状态');
      return result;
    }
    if (health.tone === 'warn') {
      result.reasons.push(`账号当前有警告但仍可能可调度：${health.reasons.join('；')}`);
    }

    if (sub2SupportsDailyQuota(account)) {
      const quotaSnapshots = [
        sub2GetQuotaUsageSnapshot(account, 'total', now),
        sub2GetQuotaUsageSnapshot(account, 'daily', now),
        sub2GetQuotaUsageSnapshot(account, 'weekly', now),
      ];
      const quotaLabels = { total: '总配额', daily: '日配额', weekly: '周配额' };
      const exceededQuota = quotaSnapshots.find((quotaSnapshot) => quotaSnapshot.exceeded);
      if (exceededQuota) {
        result.status = 'constrained';
        result.tone = 'constrained';
        result.evidence = '当前快照';
        result.reasons.push(
          `当前${quotaLabels[exceededQuota.dimension]}已用尽（$${sub2FormatCost(exceededQuota.used)} / $${sub2FormatCost(exceededQuota.limit)}）`,
        );
        return result;
      }
    }

    const savedModelState = context.savedModelState || null;
    if (recentRequest.model) {
      const modelSupport = sub2EvaluateModelSupport(account, recentRequest.model, savedModelState);
      result.modelCheckNeeded = modelSupport.checkNeeded;
      result.reasons.push(modelSupport.reason);
      if (modelSupport.status === 'unsupported') {
        result.status = 'excluded';
        result.tone = 'excluded';
        result.evidence = modelSupport.evidence;
        return result;
      }
      if (modelSupport.status === 'unknown') {
        modelCheckUnknown = true;
        result.evidence = '信息不足';
      }
    }

    const concurrency = context.concurrency || null;
    let capacityCheckUnknown = false;
    const currentInUse = concurrency?.currentInUse;
    const maxCapacity = concurrency?.maxCapacity;
    const waitingInQueue = concurrency?.waitingInQueue;
    if (context.concurrencyAvailable === false) {
      capacityCheckUnknown = true;
      result.reasons.push('容量接口不可用，无法核对请求发生时的负载');
    } else if (context.concurrencyEnabled === false) {
      capacityCheckUnknown = true;
      result.reasons.push('容量统计当前未启用，无法核对账号负载');
    } else if (Number.isFinite(maxCapacity) && maxCapacity > 0 && Number.isFinite(currentInUse)) {
      result.reasons.push(`当前容量 ${currentInUse} / ${maxCapacity}${waitingInQueue > 0 ? `，排队 ${waitingInQueue}` : ''}`);
      if (currentInUse >= maxCapacity) {
        result.status = 'constrained';
        result.tone = 'constrained';
        result.evidence = '当前快照';
        result.reasons.push('当前容量已满，调度器可能排队或选择其他账号');
        return result;
      }
    } else if (!concurrency) {
      capacityCheckUnknown = true;
      result.reasons.push('容量接口未返回该账号记录，当前负载未知');
    } else {
      capacityCheckUnknown = true;
      result.reasons.push('账号容量记录缺少有效上限或占用值，当前负载未知');
    }

    if (modelCheckUnknown || result.modelCheckNeeded || capacityCheckUnknown) {
      result.status = 'unknown';
      result.tone = 'unknown';
      result.evidence = '信息不足';
      result.reasons.push('其余当前配置允许进入候选，但会话粘连和调度权重仍可能跳过');
      return result;
    }

    result.status = 'eligible';
    result.tone = 'eligible';
    result.evidence = '当前快照';
    result.reasons.push('当前平台、分组、状态、配额、模型和容量未发现排除条件');
    result.reasons.push('仍不能证明历史请求一定进入候选；会话粘连和调度权重可能跳过');
    return result;
  }

  function sub2AccountMatchesFilter(account, memberships, filterText) {
    const normalizedFilter = String(filterText || '').trim().toLocaleLowerCase();
    if (!normalizedFilter) return true;
    const searchableValues = [account?.name, account?.platform];
    for (const membership of memberships) {
      searchableValues.push(membership.name, membership.platform);
    }
    return searchableValues.some((value) => String(value || '').toLocaleLowerCase().includes(normalizedFilter));
  }

  function sub2BuildGroupedSections(accounts, statsById, sortMode, filterText, now = Date.now(), groupsById = null) {
    const sectionsByKey = new Map();
    const ungroupedMembership = {
      groupId: null,
      groupKey: 'ungrouped',
      name: '未分组',
      platform: '',
      priority: null,
      status: '',
      ungrouped: true,
    };

    for (const account of Array.isArray(accounts) ? accounts : []) {
      const memberships = sub2GetGroupMemberships(account, groupsById);
      const displayMemberships = memberships.length ? memberships : [ungroupedMembership];
      const normalizedFilter = String(filterText || '').trim().toLocaleLowerCase();
      const accountMatches = !normalizedFilter
        || String(account?.name || '').toLocaleLowerCase().includes(normalizedFilter)
        || String(account?.platform || '').toLocaleLowerCase().includes(normalizedFilter);

      for (const membership of displayMemberships) {
        const groupMatches = !normalizedFilter
          || membership.name.toLocaleLowerCase().includes(normalizedFilter)
          || membership.platform.toLocaleLowerCase().includes(normalizedFilter);
        if (!accountMatches && !groupMatches) continue;

        if (!sectionsByKey.has(membership.groupKey)) {
          sectionsByKey.set(membership.groupKey, {
            groupId: membership.groupId,
            groupKey: membership.groupKey,
            name: membership.name,
            platform: membership.platform,
            status: membership.status,
            ungrouped: membership.ungrouped === true,
            entries: [],
          });
        }
        sectionsByKey.get(membership.groupKey).entries.push({
          account,
          membership: membership.ungrouped ? null : membership,
        });
      }
    }

    const sections = [...sectionsByKey.values()];
    for (const section of sections) {
      if (sortMode === 'priority') {
        section.entries.sort((left, right) => {
          const leftGroupPriority = left.membership?.priority ?? Number.POSITIVE_INFINITY;
          const rightGroupPriority = right.membership?.priority ?? Number.POSITIVE_INFINITY;
          return leftGroupPriority - rightGroupPriority
            || (Number(left.account.priority) || 0) - (Number(right.account.priority) || 0)
            || String(left.account.name || '').localeCompare(String(right.account.name || ''));
        });
      } else {
        const entriesByAccountId = new Map(section.entries.map((entry) => [String(entry.account.id), entry]));
        const sortedAccounts = sub2SortAccounts(
          section.entries.map((entry) => entry.account),
          statsById,
          sortMode,
          now,
        );
        section.entries = sortedAccounts.map((account) => entriesByAccountId.get(String(account.id)));
      }
    }

    sections.sort((left, right) => {
      if (left.ungrouped !== right.ungrouped) return left.ungrouped ? 1 : -1;
      if (left.groupId !== null && right.groupId !== null && left.groupId !== right.groupId) {
        return left.groupId - right.groupId;
      }
      return left.name.localeCompare(right.name);
    });
    return sections;
  }

  function sub2CountDistinctGroups(accounts, groupsById = null) {
    const groupKeys = new Set();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      const memberships = sub2GetGroupMemberships(account, groupsById);
      for (const membership of memberships) groupKeys.add(membership.groupKey);
    }
    return groupKeys.size;
  }

  // 收集当前账号里出现过的平台（去重、按名称排序），用于生成平台筛选下拉。
  function sub2CollectPlatforms(accounts) {
    const platforms = new Set();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      const platform = String(account?.platform || '').trim();
      if (platform) platforms.add(platform);
    }
    return [...platforms].sort((left, right) => left.localeCompare(right));
  }

  // 收集分组下拉的选项：全部分组 / 未分配分组 / 各分组（带账号计数）。
  // 返回 [{ key, name, count, special? }]，special 标记 all / ungrouped。
  function sub2CollectGroupOptions(accounts, groupsById = null) {
    const sourceAccounts = Array.isArray(accounts) ? accounts : [];
    const optionsByKey = new Map();
    let ungroupedCount = 0;

    for (const account of sourceAccounts) {
      const memberships = sub2GetGroupMemberships(account, groupsById);
      if (!memberships.length) {
        ungroupedCount += 1;
        continue;
      }
      for (const membership of memberships) {
        if (!optionsByKey.has(membership.groupKey)) {
          optionsByKey.set(membership.groupKey, {
            key: membership.groupKey,
            name: membership.name,
            groupId: membership.groupId,
            count: 0,
          });
        }
        optionsByKey.get(membership.groupKey).count += 1;
      }
    }

    const groupOptions = [...optionsByKey.values()].sort((left, right) => {
      if (left.groupId !== null && right.groupId !== null && left.groupId !== right.groupId) {
        return left.groupId - right.groupId;
      }
      return left.name.localeCompare(right.name);
    });

    const options = [{ key: '', name: '全部分组', count: sourceAccounts.length, special: 'all' }];
    if (ungroupedCount > 0) {
      options.push({ key: 'ungrouped', name: '未分配分组', count: ungroupedCount, special: 'ungrouped' });
    }
    return options.concat(groupOptions);
  }

  // 判断账号是否命中当前激活的筛选（分组 / 平台 / 健康 / 文字）。纯函数，便于测试。
  function sub2AccountMatchesActiveFilters(account, memberships, filters, now = Date.now()) {
    const groupFilter = String(filters?.groupFilter || '');
    const platformFilter = String(filters?.platformFilter || '');
    const healthFilter = String(filters?.healthFilter || '');
    const filterText = String(filters?.filterText || '').trim().toLocaleLowerCase();
    const membershipList = Array.isArray(memberships) ? memberships : [];

    if (groupFilter === 'ungrouped') {
      if (membershipList.length) return false;
    } else if (groupFilter) {
      if (!membershipList.some((membership) => membership.groupKey === groupFilter)) return false;
    }

    if (platformFilter && String(account?.platform || '').trim() !== platformFilter) return false;

    if (healthFilter && sub2ComputeHealth(account, now).tone !== healthFilter) return false;

    if (filterText && !sub2AccountMatchesFilter(account, membershipList, filterText)) return false;

    return true;
  }

  async function sub2ApiRequest(method, path, body, signal = null) {
    const token = sub2ReadAuthToken();
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const options = { method, headers, credentials: 'same-origin' };
    if (signal) options.signal = signal;
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

  async function sub2ApiRequestWithTimeout(method, path, body, timeoutMs = 4000) {
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(() => abortController.abort(), timeoutMs);
    try {
      return await sub2ApiRequest(method, path, body, abortController.signal);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function sub2FetchAccounts() {
    const data = await sub2ApiRequest('GET', '/admin/accounts?page=1&page_size=200');
    return Array.isArray(data?.items) ? data.items : [];
  }

  async function sub2FetchAccount(accountId) {
    return sub2ApiRequest('GET', `/admin/accounts/${accountId}`);
  }

  async function sub2FetchGroups() {
    const data = await sub2ApiRequest('GET', '/admin/groups/all?include_inactive=true');
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.groups)) return data.groups;
    if (Array.isArray(data?.list)) return data.list;
    return [];
  }

  async function sub2FetchTodayStats(accountIds) {
    if (!Array.isArray(accountIds) || !accountIds.length) return {};
    const data = await sub2ApiRequest('POST', '/admin/accounts/today-stats/batch', { account_ids: accountIds });
    return data?.stats || {};
  }

  async function sub2FetchRecentRoutingActivity() {
    const [requestResult, errorResult, concurrencyResult] = await Promise.allSettled([
      sub2ApiRequestWithTimeout(
        'GET',
        `/admin/ops/requests?time_range=30m&kind=all&sort=created_at_desc&page=1&page_size=${SUB2_REQUEST_HISTORY_LIMIT}`,
      ),
      sub2ApiRequestWithTimeout(
        'GET',
        '/admin/ops/upstream-errors?time_range=30m&page=1&page_size=200',
      ),
      sub2ApiRequestWithTimeout('GET', '/admin/ops/concurrency'),
    ]);

    const normalizedRequestHistory = requestResult.status === 'fulfilled'
      ? sub2NormalizeRequestHistory(requestResult.value)
      : [];
    const requestHistory = sub2AnnotateRequestHistory(
      normalizedRequestHistory,
      errorResult.status === 'fulfilled' ? errorResult.value : null,
      errorResult.status === 'fulfilled' && sub2IsPaginatedPayloadComplete(errorResult.value),
    );
    const recentRequest = requestHistory.find(
      (requestItem) => requestItem.kind === 'success' && requestItem.accountId,
    ) || null;
    const errorCoverageComplete = errorResult.status === 'fulfilled'
      && sub2IsPaginatedPayloadComplete(errorResult.value);
    const correlatedErrors = errorResult.status === 'fulfilled'
      ? sub2GetCorrelatedRoutingErrors(errorResult.value, recentRequest)
      : [];
    const correlatedErrorIds = correlatedErrors
      .map((routingError) => routingError.id)
      .filter((errorId, index, errorIds) => errorId && errorIds.indexOf(errorId) === index);
    const fetchedErrorIds = correlatedErrorIds.slice(0, 8);
    const detailRequests = fetchedErrorIds
      .map((errorId) => sub2ApiRequestWithTimeout(
        'GET',
        `/admin/ops/upstream-errors/${errorId}`,
        undefined,
        3500,
      ));
    const detailResults = detailRequests.length ? await Promise.allSettled(detailRequests) : [];
    const detailPayloads = detailResults
      .filter((detailResult) => detailResult.status === 'fulfilled')
      .map((detailResult) => detailResult.value);
    const routeDetailsComplete = errorCoverageComplete
      && correlatedErrorIds.length === fetchedErrorIds.length
      && detailResults.every((detailResult) => detailResult.status === 'fulfilled');
    const concurrencySnapshot = concurrencyResult.status === 'fulfilled'
      ? sub2NormalizeConcurrencySnapshot(concurrencyResult.value)
      : null;
    const routeChain = sub2BuildRouteChain(
      recentRequest,
      correlatedErrors,
      detailPayloads,
      routeDetailsComplete,
    );
    const errorByAccountId = errorResult.status === 'fulfilled'
      ? sub2BuildRecentRoutingErrorIndex(errorResult.value, recentRequest)
      : new Map();
    const routingErrors = errorResult.status === 'fulfilled'
      ? sub2NormalizeRoutingErrors(errorResult.value)
      : [];
    sub2MergeRouteFailuresIntoErrorIndex(errorByAccountId, routeChain, recentRequest);

    return {
      requestsAvailable: requestResult.status === 'fulfilled',
      errorsAvailable: errorResult.status === 'fulfilled',
      errorsComplete: errorCoverageComplete,
      concurrencyAvailable: concurrencyResult.status === 'fulfilled',
      recentRequest,
      requestHistory,
      routingErrors,
      errorByAccountId,
      routeChain,
      routeDetailsAvailable: errorResult.status === 'fulfilled'
        && (!correlatedErrorIds.length || routeDetailsComplete),
      concurrencySnapshot,
    };
  }

  async function sub2FetchReliabilityActivity() {
    const [requestResult, errorResult] = await Promise.allSettled([
      sub2ApiRequestWithTimeout(
        'GET',
        `/admin/ops/requests?time_range=24h&kind=all&sort=created_at_desc&page=1&page_size=${SUB2_RELIABILITY_HISTORY_LIMIT}`,
        undefined,
        8000,
      ),
      sub2ApiRequestWithTimeout(
        'GET',
        `/admin/ops/upstream-errors?time_range=24h&page=1&page_size=${SUB2_RELIABILITY_HISTORY_LIMIT}`,
        undefined,
        8000,
      ),
    ]);
    if (requestResult.status !== 'fulfilled') {
      throw requestResult.reason || new Error('24 小时请求记录不可用');
    }
    return sub2BuildReliabilitySnapshot(
      requestResult.value,
      errorResult.status === 'fulfilled' ? errorResult.value : null,
    );
  }

  async function sub2FetchRouteReplay(requestItem) {
    const requestId = String(requestItem?.requestId || '').trim();
    if (!requestId) {
      return {
        errorsAvailable: false,
        errorsComplete: false,
        routeChain: sub2BuildRouteChain(requestItem, [], [], false),
        routeDetailsAvailable: false,
      };
    }

    const encodedRequestId = encodeURIComponent(requestId);
    const errorPayload = await sub2ApiRequestWithTimeout(
      'GET',
      `/admin/ops/upstream-errors?time_range=24h&page=1&page_size=100&q=${encodedRequestId}`,
      undefined,
      5000,
    );
    const errorCoverageComplete = sub2IsPaginatedPayloadComplete(errorPayload);
    const correlatedErrors = sub2GetCorrelatedRoutingErrors(errorPayload, requestItem);
    const correlatedErrorIds = correlatedErrors
      .map((routingError) => routingError.id)
      .filter((errorId, index, errorIds) => errorId && errorIds.indexOf(errorId) === index);
    const fetchedErrorIds = correlatedErrorIds.slice(0, 8);
    const detailResults = await Promise.allSettled(fetchedErrorIds.map((errorId) => sub2ApiRequestWithTimeout(
      'GET',
      `/admin/ops/upstream-errors/${errorId}`,
      undefined,
      3500,
    )));
    const detailPayloads = detailResults
      .filter((detailResult) => detailResult.status === 'fulfilled')
      .map((detailResult) => detailResult.value);
    const routeDetailsComplete = errorCoverageComplete
      && correlatedErrorIds.length === fetchedErrorIds.length
      && detailResults.every((detailResult) => detailResult.status === 'fulfilled');
    return {
      errorsAvailable: true,
      errorsComplete: errorCoverageComplete,
      routeChain: sub2BuildRouteChain(requestItem, correlatedErrors, detailPayloads, routeDetailsComplete),
      routeDetailsAvailable: !correlatedErrorIds.length || routeDetailsComplete,
    };
  }

  async function sub2FetchAccountModels(accountId) {
    const data = await sub2ApiRequest('GET', `/admin/accounts/${accountId}/models`);
    return sub2NormalizeModels(data);
  }

  async function sub2SyncAccountModels(accountId) {
    // 该 POST 会访问上游并同步账号模型配置，只能由模型抽屉里的手动按钮触发。
    await sub2ApiRequest('POST', `/admin/accounts/${accountId}/models/sync-upstream`);
    return sub2FetchAccountModels(accountId);
  }

  async function sub2SetSchedulable(accountId, schedulable) {
    return sub2ApiRequest('POST', `/admin/accounts/${accountId}/schedulable`, { schedulable });
  }

  async function sub2RecoverState(accountId) {
    return sub2ApiRequest('POST', `/admin/accounts/${accountId}/recover-state`);
  }

  async function sub2UpdatePriority(account, priority) {
    // 只更新账号级 priority，避免 group_ids 触发分组关联重建并覆盖组内优先级。
    return sub2ApiRequest('PUT', `/admin/accounts/${account.id}`, { priority });
  }

  async function sub2UpdateCapacity(account, concurrency) {
    // 官方更新 DTO 将 concurrency 定义为指针；只提交该字段不会重写凭据、分组或优先级。
    return sub2ApiRequest('PUT', `/admin/accounts/${account.id}`, { concurrency });
  }

  async function sub2UpdateDailyQuota(account, dailyLimit) {
    // sub2 更新 extra 时会整体替换 JSON，因此先读取账号最新详情并完整保留其它 extra 字段。
    const latestAccount = await sub2FetchAccount(account.id);
    const sourceExtra = latestAccount?.extra && typeof latestAccount.extra === 'object'
      ? latestAccount.extra
      : {};
    const updatedExtra = sub2BuildDailyQuotaExtra(sourceExtra, dailyLimit);

    return sub2ApiRequest('PUT', `/admin/accounts/${account.id}`, { extra: updatedExtra });
  }

  const SUB2_STYLE = `
    #${SUB2_TOGGLE_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
      background:#2563eb;color:#fff;border:none;box-shadow:0 6px 18px rgba(37,99,235,.4);cursor:pointer;font-size:13px;font-weight:700;}
    #${SUB2_TOGGLE_ID}:hover{background:#1d4ed8;}
    #${SUB2_PANEL_ID}{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:430px;max-width:calc(100vw - 36px);
      height:clamp(680px,80vh,820px);max-height:calc(100vh - 110px);display:flex;flex-direction:column;background:#fff;color:#0f172a;border:1px solid #e2e8f0;
      border-radius:12px;box-shadow:0 12px 40px rgba(15,23,42,.22);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      font-size:13px;overflow:hidden;isolation:isolate;}
    #${SUB2_PANEL_ID}.sub2-hidden{display:none;}
    #${SUB2_PANEL_ID} .sub2-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
      background:#0f172a;color:#fff;}
    #${SUB2_PANEL_ID} .sub2-head b{font-size:14px;}
    #${SUB2_PANEL_ID} .sub2-version{margin-left:5px;color:#93c5fd;font-size:11px;font-weight:600;}
    #${SUB2_PANEL_ID} .sub2-head .sub2-min{background:transparent;border:none;color:#cbd5e1;cursor:pointer;font-size:16px;line-height:1;}
    #${SUB2_PANEL_ID} .sub2-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-chip{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;}
    #${SUB2_PANEL_ID} .sub2-chip.ok{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-chip.warn{background:#fef9c3;color:#854d0e;}
    #${SUB2_PANEL_ID} .sub2-chip.paused{background:#e2e8f0;color:#475569;}
    #${SUB2_PANEL_ID} .sub2-chip.down{background:#fee2e2;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-chip.info{background:#dbeafe;color:#1d4ed8;}
    #${SUB2_PANEL_ID} .sub2-chip.muted{background:#f1f5f9;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-head-actions{display:flex;align-items:center;gap:7px;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-open{border:1px solid #60a5fa;border-radius:999px;padding:3px 9px;
      background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-open:hover{background:#dbeafe;}
    #${SUB2_PANEL_ID} .sub2-controls{display:flex;flex-direction:column;gap:7px;padding:8px 12px;border-bottom:1px solid #f1f5f9;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-search-row{display:flex;align-items:center;gap:7px;}
    #${SUB2_PANEL_ID} .sub2-account-search{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:8px;padding:6px 9px;
      background:#fff;color:#0f172a;font-size:12px;outline:none;}
    #${SUB2_PANEL_ID} .sub2-account-search:focus,#${SUB2_PANEL_ID} .sub2-controls select:focus,
    #${SUB2_PANEL_ID} .sub2-groupfilter-btn:focus{border-color:#60a5fa;box-shadow:0 0 0 2px rgba(59,130,246,.12);}
    #${SUB2_PANEL_ID} .sub2-filter-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;}
    #${SUB2_PANEL_ID} .sub2-controls select{width:100%;min-width:0;height:28px;border:1px solid #cbd5e1;border-radius:7px;
      padding:4px 2px;background:#fff;color:#334155;font-size:10px;outline:none;cursor:pointer;}
    #${SUB2_PANEL_ID} .sub2-groupfilter{position:relative;min-width:0;}
    #${SUB2_PANEL_ID} .sub2-groupfilter-btn{width:100%;display:flex;align-items:center;justify-content:space-between;gap:4px;
      height:28px;border:1px solid #cbd5e1;border-radius:7px;padding:4px 5px;font-size:10px;background:#fff;color:#334155;cursor:pointer;outline:none;}
    #${SUB2_PANEL_ID} .sub2-groupfilter-btn .sub2-gf-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-groupfilter-btn .sub2-gf-caret{color:#94a3b8;font-size:10px;}
    #${SUB2_PANEL_ID} .sub2-groupfilter-pop{position:absolute;left:0;top:calc(100% + 4px);z-index:5;width:220px;max-width:calc(100vw - 52px);background:#fff;
      border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.18);padding:6px;display:none;}
    #${SUB2_PANEL_ID} .sub2-groupfilter.open .sub2-groupfilter-pop{display:block;}
    #${SUB2_PANEL_ID} .sub2-groupfilter-pop input{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;
      padding:4px 6px;font-size:12px;margin-bottom:6px;}
    #${SUB2_PANEL_ID} .sub2-groupfilter-options{max-height:180px;overflow-y:auto;display:flex;flex-direction:column;}
    #${SUB2_PANEL_ID} .sub2-gf-option{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;
      border-radius:6px;cursor:pointer;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-gf-option:hover{background:#f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-gf-option.active{background:#eff6ff;color:#1d4ed8;font-weight:600;}
    #${SUB2_PANEL_ID} .sub2-gf-option .sub2-gf-count{color:#94a3b8;font-size:11px;font-weight:400;}
    #${SUB2_PANEL_ID} .sub2-gf-option.active .sub2-gf-count{color:#60a5fa;}
    #${SUB2_PANEL_ID} .sub2-gf-empty{padding:6px 7px;color:#94a3b8;font-size:11px;}
    #${SUB2_PANEL_ID} .sub2-refresh{height:30px;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:0 12px;
      cursor:pointer;font-size:12px;font-weight:650;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-refresh:hover{background:#1d4ed8;}
    #${SUB2_PANEL_ID} .sub2-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-list.sub2-flat-list{display:flex;flex-direction:column;}
    #${SUB2_PANEL_ID} .sub2-group{border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;overflow:hidden;}
    #${SUB2_PANEL_ID} .sub2-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 9px;
      border-bottom:1px solid #e2e8f0;background:#eef2ff;}
    #${SUB2_PANEL_ID} .sub2-group-title{display:flex;align-items:center;gap:6px;min-width:0;}
    #${SUB2_PANEL_ID} .sub2-group-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1e3a8a;}
    #${SUB2_PANEL_ID} .sub2-group-platform{padding:1px 6px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-size:10px;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-group-summary{max-width:58%;color:#64748b;font-size:10px;line-height:1.4;text-align:right;}
    #${SUB2_PANEL_ID} .sub2-group-list{display:flex;flex-direction:column;gap:6px;padding:6px;}
    #${SUB2_PANEL_ID} .sub2-group-membership{color:#1d4ed8;}
    #${SUB2_PANEL_ID} .sub2-row{border:1px solid #e2e8f0;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-row.tone-down{border-color:#fecaca;background:#fef2f2;}
    #${SUB2_PANEL_ID} .sub2-row.tone-warn{border-color:#fde68a;background:#fffbeb;}
    #${SUB2_PANEL_ID} .sub2-row.tone-paused{background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-row-top{display:flex;align-items:center;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-name-slot{flex:1;min-width:0;overflow:hidden;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-name{display:inline-block;max-width:100%;font-weight:700;overflow:hidden;text-overflow:ellipsis;
      white-space:nowrap;color:#0f172a;vertical-align:top;}
    #${SUB2_PANEL_ID} .sub2-name-link{text-decoration:none;cursor:pointer;}
    #${SUB2_PANEL_ID} .sub2-name-link:hover{color:#2563eb;text-decoration:underline;}
    #${SUB2_PANEL_ID} .sub2-name-link::after{content:" ↗";color:#60a5fa;font-size:10px;text-decoration:none;}
    #${SUB2_PANEL_ID} .sub2-priority{display:inline-flex;align-items:baseline;gap:2px;padding:2px 7px;border-radius:7px;
      background:#4f46e5;color:#fff;box-shadow:0 2px 6px rgba(79,70,229,.22);font-size:10px;font-weight:700;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-priority strong{font-size:13px;line-height:1;}
    #${SUB2_PANEL_ID} .sub2-badge{padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;}
    #${SUB2_PANEL_ID} .sub2-badge.ok{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-badge.warn{background:#fef9c3;color:#854d0e;}
    #${SUB2_PANEL_ID} .sub2-badge.paused{background:#e2e8f0;color:#475569;}
    #${SUB2_PANEL_ID} .sub2-badge.down{background:#fee2e2;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-hit-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;cursor:pointer;
      background:#cffafe;color:#155e75;border:1px solid #67e8f9;font-size:10px;font-weight:750;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-hit-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:#06b6d4;
      box-shadow:0 0 0 3px rgba(6,182,212,.14);}
    #${SUB2_PANEL_ID} .sub2-platform{font-size:11px;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-meta{font-size:12px;color:#475569;display:flex;flex-wrap:wrap;gap:6px 9px;}
    #${SUB2_PANEL_ID} .sub2-quota-summary{font-weight:600;color:#0369a1;}
    #${SUB2_PANEL_ID} .sub2-quota-summary.warn{color:#b45309;}
    #${SUB2_PANEL_ID} .sub2-quota-summary.down{color:#b91c1c;}
    #${SUB2_PANEL_ID} .sub2-capacity-state{font-weight:600;color:#0369a1;cursor:help;}
    #${SUB2_PANEL_ID} .sub2-capacity-state.warn{color:#b45309;}
    #${SUB2_PANEL_ID} .sub2-capacity-state.down{color:#b91c1c;}
    #${SUB2_PANEL_ID} .sub2-pool-state{color:#7c3aed;font-weight:600;cursor:help;}
    #${SUB2_PANEL_ID} .sub2-reasons{font-size:11px;color:#64748b;line-height:1.5;}
    #${SUB2_PANEL_ID} .sub2-routing-note{display:flex;align-items:flex-start;gap:6px;padding:5px 7px;border-radius:7px;
      background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:10px;line-height:1.45;}
    #${SUB2_PANEL_ID} .sub2-routing-note.hit{background:#ecfeff;border-color:#a5f3fc;color:#155e75;}
    #${SUB2_PANEL_ID} .sub2-routing-note.verified{background:#fff7ed;border-color:#fed7aa;color:#9a3412;}
    #${SUB2_PANEL_ID} .sub2-routing-note.down{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-routing-note.inferred{background:#f8fafc;border-style:dashed;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-routing-evidence{flex:none;padding:1px 5px;border-radius:999px;background:rgba(255,255,255,.72);
      border:1px solid currentColor;font-size:9px;font-weight:700;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-actions{display:flex;flex-wrap:wrap;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-btn{border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-btn:hover{background:#f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-btn.danger{border-color:#fecaca;color:#b91c1c;}
    #${SUB2_PANEL_ID} .sub2-btn.primary{border-color:#bfdbfe;color:#1d4ed8;}
    #${SUB2_PANEL_ID} .sub2-btn:disabled{opacity:.5;cursor:not-allowed;}
    #${SUB2_PANEL_ID} .sub2-quota-editor{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px;
      padding:7px;border:1px solid #bae6fd;border-radius:8px;background:#f0f9ff;}
    #${SUB2_PANEL_ID} .sub2-quota-editor[hidden]{display:none;}
    #${SUB2_PANEL_ID} .sub2-quota-input-wrap{display:flex;align-items:center;min-width:0;border:1px solid #7dd3fc;border-radius:6px;background:#fff;overflow:hidden;}
    #${SUB2_PANEL_ID} .sub2-quota-prefix{padding:0 6px;color:#0369a1;font-weight:700;}
    #${SUB2_PANEL_ID} .sub2-quota-input{width:100%;min-width:0;border:none;outline:none;padding:5px 6px 5px 0;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-quota-help{grid-column:1 / -1;color:#64748b;font-size:10px;line-height:1.4;}
    #${SUB2_PANEL_ID} .sub2-capacity-editor{display:grid;grid-template-columns:auto minmax(72px,1fr) auto auto;align-items:center;gap:6px;
      padding:7px;border:1px solid #c4b5fd;border-radius:8px;background:#f5f3ff;}
    #${SUB2_PANEL_ID} .sub2-capacity-editor[hidden]{display:none;}
    #${SUB2_PANEL_ID} .sub2-capacity-step{width:28px;height:28px;border:1px solid #c4b5fd;border-radius:6px;background:#fff;color:#5b21b6;
      font-size:16px;font-weight:700;line-height:1;cursor:pointer;}
    #${SUB2_PANEL_ID} .sub2-capacity-input{width:100%;min-width:0;box-sizing:border-box;border:1px solid #a78bfa;border-radius:6px;
      padding:5px 6px;color:#0f172a;font-size:12px;text-align:center;outline:none;}
    #${SUB2_PANEL_ID} .sub2-capacity-help{grid-column:1 / -1;color:#64748b;font-size:10px;line-height:1.45;}
    #${SUB2_PANEL_ID} .sub2-capacity-warning{grid-column:1 / -1;color:#b45309;font-size:10px;line-height:1.45;}
    #${SUB2_PANEL_ID} .sub2-capacity-warning:empty{display:none;}
    #${SUB2_PANEL_ID} .sub2-status{padding:6px 12px;border-top:1px solid #f1f5f9;font-size:11px;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-status.error{color:#b91c1c;}
    #${SUB2_PANEL_ID} .sub2-model-overlay{position:absolute;inset:0;z-index:20;display:flex;justify-content:flex-end;
      background:rgba(15,23,42,.36);backdrop-filter:blur(1px);}
    #${SUB2_PANEL_ID} .sub2-model-overlay[hidden]{display:none;}
    #${SUB2_PANEL_ID} .sub2-model-drawer{width:100%;height:100%;display:flex;flex-direction:column;background:#fff;
      border-left:1px solid #cbd5e1;box-shadow:-10px 0 28px rgba(15,23,42,.16);}
    #${SUB2_PANEL_ID} .sub2-model-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;
      border-bottom:1px solid #e2e8f0;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-model-heading{min-width:0;}
    #${SUB2_PANEL_ID} .sub2-model-title{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-model-subtitle{margin-top:3px;color:#64748b;font-size:11px;line-height:1.4;}
    #${SUB2_PANEL_ID} .sub2-model-close{border:none;background:transparent;color:#64748b;cursor:pointer;font-size:20px;line-height:1;padding:0 2px;}
    #${SUB2_PANEL_ID} .sub2-model-toolbar{display:flex;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid #f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-model-toolbar input{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:6px;padding:5px 7px;font-size:12px;}
    #${SUB2_PANEL_ID} .sub2-model-sync{white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-model-notice{padding:7px 12px;background:#fff7ed;color:#9a3412;border-bottom:1px solid #fed7aa;font-size:11px;line-height:1.45;}
    #${SUB2_PANEL_ID} .sub2-model-state{padding:7px 12px;color:#64748b;font-size:11px;border-bottom:1px solid #f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-model-state.error{color:#b91c1c;background:#fef2f2;}
    #${SUB2_PANEL_ID} .sub2-model-list{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:1fr;
      align-content:start;gap:6px;padding:9px 10px;}
    #${SUB2_PANEL_ID} .sub2-model-item{min-width:0;padding:7px 8px;border:1px solid #e2e8f0;border-radius:7px;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-model-id{display:block;color:#0f172a;font-size:11px;font-weight:650;overflow-wrap:anywhere;}
    #${SUB2_PANEL_ID} .sub2-model-meta{display:block;margin-top:3px;color:#64748b;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-model-empty{grid-column:1 / -1;padding:24px 12px;color:#64748b;text-align:center;line-height:1.6;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-overlay{position:absolute;inset:0;z-index:21;display:flex;justify-content:flex-end;
      background:rgba(15,23,42,.36);backdrop-filter:blur(1px);}
    #${SUB2_PANEL_ID} .sub2-diagnostics-overlay[hidden]{display:none;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-drawer{width:100%;height:100%;display:flex;flex-direction:column;background:#fff;
      border-left:1px solid #cbd5e1;box-shadow:-10px 0 28px rgba(15,23,42,.16);}
    #${SUB2_PANEL_ID} .sub2-diagnostics-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;
      border-bottom:1px solid #e2e8f0;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-title{display:block;font-size:14px;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-subtitle{margin-top:3px;color:#64748b;font-size:11px;line-height:1.4;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-close{border:none;background:transparent;color:#64748b;cursor:pointer;font-size:20px;line-height:1;padding:0 2px;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-body{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-card{border:1px solid #e2e8f0;border-radius:9px;background:#fff;padding:9px;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-card h3{margin:0 0 6px;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-history-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-bottom:7px;}
    #${SUB2_PANEL_ID} .sub2-history-filters select{min-width:0;width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:4px 5px;
      background:#fff;color:#334155;font-size:10px;outline:none;}
    #${SUB2_PANEL_ID} .sub2-history-list{display:flex;flex-direction:column;gap:5px;max-height:230px;overflow-y:auto;}
    #${SUB2_PANEL_ID} .sub2-history-item{width:100%;display:flex;align-items:center;gap:7px;box-sizing:border-box;border:1px solid #e2e8f0;
      border-radius:7px;padding:6px 7px;background:#f8fafc;color:#334155;text-align:left;cursor:pointer;}
    #${SUB2_PANEL_ID} .sub2-history-item:hover{border-color:#93c5fd;background:#eff6ff;}
    #${SUB2_PANEL_ID} .sub2-history-item.selected{border-color:#60a5fa;background:#dbeafe;box-shadow:0 0 0 1px rgba(59,130,246,.12);}
    #${SUB2_PANEL_ID} .sub2-history-main{flex:1;min-width:0;}
    #${SUB2_PANEL_ID} .sub2-history-title{display:block;font-size:10px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-history-meta{display:block;margin-top:2px;color:#64748b;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-history-badges{display:flex;flex-direction:column;align-items:flex-end;gap:3px;}
    #${SUB2_PANEL_ID} .sub2-history-badge{padding:1px 5px;border-radius:999px;background:#e2e8f0;color:#475569;font-size:8px;font-weight:750;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-history-badge.success{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-history-badge.error{background:#fee2e2;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-history-badge.failover{background:#ffedd5;color:#9a3412;}
    #${SUB2_PANEL_ID} .sub2-history-badge.direct{background:#e0f2fe;color:#075985;}
    #${SUB2_PANEL_ID} .sub2-request-facts{display:flex;flex-wrap:wrap;gap:5px 9px;color:#475569;font-size:11px;line-height:1.5;}
    #${SUB2_PANEL_ID} .sub2-diagnostics-note{padding:7px 9px;border-radius:7px;background:#f8fafc;color:#64748b;font-size:10px;line-height:1.5;}
    #${SUB2_PANEL_ID} .sub2-route-chain{display:flex;flex-direction:column;gap:0;}
    #${SUB2_PANEL_ID} .sub2-route-event{position:relative;margin-left:7px;padding:0 0 10px 18px;border-left:2px solid #cbd5e1;}
    #${SUB2_PANEL_ID} .sub2-route-event:last-child{padding-bottom:0;border-left-color:transparent;}
    #${SUB2_PANEL_ID} .sub2-route-event::before{content:"";position:absolute;left:-6px;top:2px;width:9px;height:9px;border-radius:50%;
      background:#ef4444;border:1px solid #fff;box-shadow:0 0 0 1px #fca5a5;}
    #${SUB2_PANEL_ID} .sub2-route-event.success::before{background:#22c55e;box-shadow:0 0 0 1px #86efac;}
    #${SUB2_PANEL_ID} .sub2-route-event-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:700;}
    #${SUB2_PANEL_ID} .sub2-route-event-time{color:#94a3b8;font-size:10px;font-weight:500;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-route-event-reason{margin-top:3px;color:#64748b;font-size:10px;line-height:1.45;overflow-wrap:anywhere;}
    #${SUB2_PANEL_ID} .sub2-candidate-list{display:flex;flex-direction:column;gap:7px;}
    #${SUB2_PANEL_ID} .sub2-candidate{padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-candidate-head{display:flex;align-items:center;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-candidate-name{flex:1;min-width:0;font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-candidate-priority{color:#4f46e5;font-size:10px;font-weight:700;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-candidate-badge{padding:1px 6px;border-radius:999px;font-size:9px;font-weight:700;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-candidate-badge.attempted{background:#ffedd5;color:#9a3412;}
    #${SUB2_PANEL_ID} .sub2-candidate-badge.excluded{background:#fee2e2;color:#991b1b;}
    #${SUB2_PANEL_ID} .sub2-candidate-badge.constrained{background:#fef3c7;color:#92400e;}
    #${SUB2_PANEL_ID} .sub2-candidate-badge.eligible{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-candidate-badge.unknown{background:#e2e8f0;color:#475569;}
    #${SUB2_PANEL_ID} .sub2-candidate-reasons{margin-top:5px;color:#64748b;font-size:10px;line-height:1.5;}
    #${SUB2_PANEL_ID} .sub2-candidate-model-button{margin-top:6px;border:1px solid #bfdbfe;border-radius:6px;padding:3px 7px;
      background:#fff;color:#1d4ed8;font-size:10px;cursor:pointer;}
    #${SUB2_PANEL_ID} .sub2-candidate-model-button:disabled{opacity:.55;cursor:not-allowed;}
    #${SUB2_PANEL_ID} .sub2-events-overlay{position:absolute;inset:0;z-index:22;display:flex;justify-content:flex-end;
      background:rgba(15,23,42,.36);backdrop-filter:blur(1px);}
    #${SUB2_PANEL_ID} .sub2-events-overlay[hidden]{display:none;}
    #${SUB2_PANEL_ID} .sub2-events-drawer{width:100%;height:100%;display:flex;flex-direction:column;background:#fff;
      border-left:1px solid #cbd5e1;box-shadow:-10px 0 28px rgba(15,23,42,.16);}
    #${SUB2_PANEL_ID} .sub2-events-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;
      border-bottom:1px solid #e2e8f0;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-events-title{display:block;font-size:14px;}
    #${SUB2_PANEL_ID} .sub2-events-subtitle{margin-top:3px;color:#64748b;font-size:11px;line-height:1.4;}
    #${SUB2_PANEL_ID} .sub2-events-close{border:none;background:transparent;color:#64748b;cursor:pointer;font-size:20px;line-height:1;padding:0 2px;}
    #${SUB2_PANEL_ID} .sub2-events-body{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px;}
    #${SUB2_PANEL_ID} .sub2-events-card{border:1px solid #e2e8f0;border-radius:9px;background:#fff;padding:9px;}
    #${SUB2_PANEL_ID} .sub2-events-card h3{margin:0 0 7px;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-reliability-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
    #${SUB2_PANEL_ID} .sub2-reliability-metric{padding:8px;border:1px solid #dbeafe;border-radius:8px;background:#eff6ff;}
    #${SUB2_PANEL_ID} .sub2-reliability-value{display:block;color:#1d4ed8;font-size:18px;font-weight:750;line-height:1.15;}
    #${SUB2_PANEL_ID} .sub2-reliability-label{display:block;margin-top:3px;color:#64748b;font-size:9px;line-height:1.35;}
    #${SUB2_PANEL_ID} .sub2-events-toolbar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:5px;margin-bottom:7px;}
    #${SUB2_PANEL_ID} .sub2-events-toolbar select{min-width:0;width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:4px 5px;
      background:#fff;color:#334155;font-size:10px;outline:none;}
    #${SUB2_PANEL_ID} .sub2-events-clear{border:1px solid #fecaca;border-radius:6px;padding:4px 7px;background:#fff;color:#b91c1c;font-size:10px;cursor:pointer;}
    #${SUB2_PANEL_ID} .sub2-events-policy{margin-bottom:7px;color:#64748b;font-size:9px;line-height:1.45;}
    #${SUB2_PANEL_ID} .sub2-event-list{display:flex;flex-direction:column;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-event-item{padding:7px 8px;border:1px solid #e2e8f0;border-left-width:3px;border-radius:7px;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-event-item.down{border-left-color:#ef4444;background:#fef2f2;}
    #${SUB2_PANEL_ID} .sub2-event-item.warn{border-left-color:#f59e0b;background:#fffbeb;}
    #${SUB2_PANEL_ID} .sub2-event-item.ok{border-left-color:#22c55e;background:#f0fdf4;}
    #${SUB2_PANEL_ID} .sub2-event-item.info{border-left-color:#3b82f6;background:#eff6ff;}
    #${SUB2_PANEL_ID} .sub2-event-head{display:flex;align-items:center;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-event-title{flex:1;min-width:0;color:#0f172a;font-size:10px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-event-time{color:#94a3b8;font-size:9px;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-event-detail{margin-top:3px;color:#64748b;font-size:9px;line-height:1.45;overflow-wrap:anywhere;}
    #${SUB2_PANEL_ID} .sub2-event-meta{margin-top:3px;color:#64748b;font-size:8px;line-height:1.4;}
    #${SUB2_PANEL_ID} .sub2-audit-overlay{position:absolute;inset:0;z-index:23;display:flex;justify-content:flex-end;
      background:rgba(15,23,42,.36);backdrop-filter:blur(1px);}
    #${SUB2_PANEL_ID} .sub2-audit-overlay[hidden]{display:none;}
    #${SUB2_PANEL_ID} .sub2-audit-drawer{width:100%;height:100%;display:flex;flex-direction:column;background:#fff;
      border-left:1px solid #cbd5e1;box-shadow:-10px 0 28px rgba(15,23,42,.16);}
    #${SUB2_PANEL_ID} .sub2-audit-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;
      border-bottom:1px solid #e2e8f0;background:#f8fafc;}
    #${SUB2_PANEL_ID} .sub2-audit-title{display:block;font-size:14px;}
    #${SUB2_PANEL_ID} .sub2-audit-subtitle{margin-top:3px;color:#64748b;font-size:11px;line-height:1.4;}
    #${SUB2_PANEL_ID} .sub2-audit-close{border:none;background:transparent;color:#64748b;cursor:pointer;font-size:20px;line-height:1;padding:0 2px;}
    #${SUB2_PANEL_ID} .sub2-audit-body{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px;}
    #${SUB2_PANEL_ID} .sub2-audit-card{border:1px solid #e2e8f0;border-radius:9px;background:#fff;padding:9px;}
    #${SUB2_PANEL_ID} .sub2-audit-card h3{margin:0 0 7px;font-size:12px;color:#0f172a;}
    #${SUB2_PANEL_ID} .sub2-audit-item{padding:7px 8px;border:1px solid #e2e8f0;border-left-width:3px;border-radius:7px;background:#f8fafc;margin-bottom:6px;}
    #${SUB2_PANEL_ID} .sub2-audit-item:last-child{margin-bottom:0;}
    #${SUB2_PANEL_ID} .sub2-audit-item.critical{border-left-color:#ef4444;background:#fef2f2;}
    #${SUB2_PANEL_ID} .sub2-audit-item.warning{border-left-color:#f59e0b;background:#fffbeb;}
    #${SUB2_PANEL_ID} .sub2-audit-item.info{border-left-color:#3b82f6;background:#eff6ff;}
    #${SUB2_PANEL_ID} .sub2-audit-item-head{display:flex;align-items:center;gap:6px;}
    #${SUB2_PANEL_ID} .sub2-audit-severity{padding:2px 5px;border-radius:4px;font-size:8px;font-weight:700;text-transform:uppercase;}
    #${SUB2_PANEL_ID} .sub2-audit-severity.critical{background:#ef4444;color:#fff;}
    #${SUB2_PANEL_ID} .sub2-audit-severity.warning{background:#f59e0b;color:#fff;}
    #${SUB2_PANEL_ID} .sub2-audit-severity.info{background:#3b82f6;color:#fff;}
    #${SUB2_PANEL_ID} .sub2-audit-message{flex:1;min-width:0;color:#0f172a;font-size:10px;font-weight:700;}
    #${SUB2_PANEL_ID} .sub2-audit-detail{margin-top:3px;color:#64748b;font-size:9px;line-height:1.45;overflow-wrap:anywhere;}
    #${SUB2_PANEL_ID} .sub2-audit-action{margin-top:5px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;
      color:#334155;font-size:9px;cursor:pointer;display:inline-block;}
    #${SUB2_PANEL_ID} .sub2-audit-action:hover{background:#f1f5f9;}
    @media (max-width:760px){
      #${SUB2_PANEL_ID}{width:calc(100vw - 24px);right:12px;bottom:70px;height:min(80vh,720px);}
    }
  `;

  class Sub2Controller {
    constructor() {
      this.root = null;
      this.toggle = null;
      this.listElement = null;
      this.summaryElement = null;
      this.statusElement = null;
      this.searchElement = null;
      this.viewElement = null;
      this.sortElement = null;
      this.groupElement = null;
      this.platformElement = null;
      this.healthElement = null;
      this.modelOverlayElement = null;
      this.modelTitleElement = null;
      this.modelSearchElement = null;
      this.modelSyncButtonElement = null;
      this.modelStateElement = null;
      this.modelListElement = null;
      this.diagnosticsOverlayElement = null;
      this.diagnosticsBodyElement = null;
      this.eventsOverlayElement = null;
      this.eventsBodyElement = null;
      this.accounts = [];
      this.groupsById = new Map();
      this.statsById = {};
      this.recentRequest = null;
      this.requestHistory = [];
      this.selectedDiagnosticsRequestKey = '';
      this.selectedRouteReplay = null;
      this.routeReplayCache = new Map();
      this.routeReplayLoading = false;
      this.routeReplayError = '';
      this.routeReplayRequestSequence = 0;
      this.historyModelFilter = '';
      this.historyGroupFilter = '';
      this.historyAccountFilter = '';
      this.historyRouteFilter = '';
      this.latestHit = null;
      this.recentRoutingErrorByAccountId = new Map();
      this.routeChain = { events: [], detailLevel: 'success-only' };
      this.routeDetailsAvailable = false;
      this.routingRequestsAvailable = false;
      this.routingErrorsAvailable = false;
      this.routingErrorsComplete = false;
      this.concurrencyAvailable = false;
      this.concurrencyEnabled = false;
      this.concurrencyTimestamp = 0;
      this.concurrencyByAccountId = new Map();
      this.concurrencyRecordsByAccountId = new Map();
      this.routingRequestSequence = 0;
      this.refreshTimer = null;
      this.tickTimer = null;
      this.visibilityHandler = null;
      this.loading = false;
      this.pendingRefresh = false;
      this.refreshRequestSequence = 0;
      this.quotaSaving = false;
      this.capacitySaving = false;
      this.busyIds = new Set();
      this.filterText = '';
      this.viewMode = String(sub2StorageGet('viewMode', 'group')) === 'flat' ? 'flat' : 'group';
      this.sortMode = String(sub2StorageGet('sortMode', 'health'));
      // 分组筛选：'' 表示全部；'ungrouped' 表示未分配分组；否则为分组 key（id:N 或 name:xxx）。
      this.groupFilter = String(sub2StorageGet('groupFilter', ''));
      // 平台筛选：'' 表示全部；否则为具体平台（openai/grok/anthropic/gemini…）。
      this.platformFilter = String(sub2StorageGet('platformFilter', ''));
      // 健康筛选：'' 表示全部；否则为 tone（down/warn/ok/paused）。
      this.healthFilter = String(sub2StorageGet('healthFilter', ''));
      this.groupFilterOpen = false;
      this.groupFilterSearchText = '';
      this.minimized = sub2StorageGet('minimized', false) === true;
      this.lastError = '';
      this.lastUpdatedAt = 0;
      this.modelAccount = null;
      this.models = [];
      this.modelFilterText = '';
      this.modelLoading = false;
      this.modelSyncing = false;
      this.modelMessage = '';
      this.modelError = '';
      this.modelRequestSequence = 0;
      this.savedModelsByAccountId = new Map();
      this.diagnosticsOpen = false;
      this.eventsOpen = false;
      this.auditOpen = false;
      this.eventTypeFilter = '';
      this.eventRetentionDays = sub2NormalizeEventRetentionDays(
        sub2StorageGet('eventRetentionDays', SUB2_DEFAULT_EVENT_RETENTION_DAYS),
      );
      this.localEvents = sub2PruneLocalEvents(
        sub2StorageGet('localEvents', []),
        this.eventRetentionDays,
      );
      this.eventObservationSnapshot = sub2NormalizeObservationSnapshot(
        sub2StorageGet('eventObservationSnapshot', null),
      );
      this.reliabilitySnapshot = null;
      this.reliabilityLoading = false;
      this.reliabilityError = '';
      this.reliabilityRequestSequence = 0;
      this.lastReliabilityRefreshAt = 0;
    }

    start() {
      if (typeof GM_addStyle === 'function') GM_addStyle(SUB2_STYLE);
      this.mount();
      this.refresh();
      this.refreshTimer = window.setInterval(() => {
        if (!this.minimized && document.visibilityState !== 'hidden' && !this.isAccountInteractionActive()) this.refresh();
      }, SUB2_POLL_SECONDS * 1000);
      this.visibilityHandler = () => {
        if (!this.minimized && document.visibilityState === 'visible' && !this.isAccountInteractionActive()) this.refresh();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      // 每秒重绘倒计时：仅当存在“冷却中”的账号时才重建列表，
      // 避免无谓的每秒全量重建把滚动位置顶掉（会表现为面板每秒自己往下滚）。
      this.tickTimer = window.setInterval(() => {
        if (this.minimized || !this.accounts.length || this.isAccountInteractionActive()) return;
        const now = Date.now();
        const hasCountdown = this.accounts.some((account) => sub2ComputeHealth(account, now).coolingUntil > now);
        if (hasCountdown) this.renderList();
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
      this.toggle.title = `Sub2 智能分组 v${SUB2_SCRIPT_VERSION}`;
      this.toggle.addEventListener('click', () => this.setMinimized(!this.minimized));
      document.body.appendChild(this.toggle);

      this.root = document.createElement('div');
      this.root.id = SUB2_PANEL_ID;
      this.root.innerHTML = `
        <div class="sub2-head">
          <b>Sub2 账号健康 / 路由 <span class="sub2-version">v${SUB2_SCRIPT_VERSION}</span></b>
          <div class="sub2-head-actions">
            <button type="button" class="sub2-audit-open">配置审计</button>
            <button type="button" class="sub2-events-open">事件中心</button>
            <button type="button" class="sub2-diagnostics-open">路由历史</button>
            <button class="sub2-min" title="最小化">—</button>
          </div>
        </div>
        <div class="sub2-summary"></div>
        <div class="sub2-controls">
          <div class="sub2-search-row">
            <input type="text" class="sub2-account-search" placeholder="搜索账号 / 平台 / 分组…" />
            <button class="sub2-refresh">刷新</button>
          </div>
          <div class="sub2-filter-grid">
            <div class="sub2-groupfilter">
              <button type="button" class="sub2-groupfilter-btn" title="按分组筛选">
                <span class="sub2-gf-label">全部分组</span>
                <span class="sub2-gf-caret">▼</span>
              </button>
              <div class="sub2-groupfilter-pop">
                <input type="text" class="sub2-gf-search" placeholder="搜索分组…" />
                <div class="sub2-groupfilter-options"></div>
              </div>
            </div>
            <select class="sub2-platform-filter" title="按平台筛选"></select>
            <select class="sub2-health-filter" title="按健康状态筛选">
              <option value="all">全部状态</option>
              <option value="down">不可用</option>
              <option value="warn">注意</option>
              <option value="ok">正常</option>
              <option value="paused">停用</option>
            </select>
            <select class="sub2-sort" title="账号排序">
              <option value="health">按健康</option>
              <option value="priority">按优先级</option>
              <option value="cost">按花费</option>
              <option value="name">按名称</option>
            </select>
            <select class="sub2-view" title="列表视图">
              <option value="group">分组视图</option>
              <option value="flat">账号视图</option>
            </select>
          </div>
        </div>
        <div class="sub2-list"></div>
        <div class="sub2-status">加载中…</div>
        <div class="sub2-model-overlay" hidden>
          <section class="sub2-model-drawer" role="dialog" aria-modal="true" aria-labelledby="sub2-model-title">
            <div class="sub2-model-head">
              <div class="sub2-model-heading">
                <strong id="sub2-model-title" class="sub2-model-title">账号模型</strong>
                <div class="sub2-model-subtitle">默认只读取 sub2 已保存的数据，不会访问上游。</div>
              </div>
              <button type="button" class="sub2-model-close" title="关闭" aria-label="关闭模型列表">×</button>
            </div>
            <div class="sub2-model-toolbar">
              <input type="text" class="sub2-model-search" placeholder="搜索模型…" />
              <button type="button" class="sub2-btn primary sub2-model-sync">拉取并同步上游</button>
            </div>
            <div class="sub2-model-notice">“拉取并同步上游”会真实访问一次该账号的模型接口，并由 sub2 更新账号保存的模型配置；脚本不会自动执行。</div>
            <div class="sub2-model-state">正在读取已保存模型…</div>
            <div class="sub2-model-list"></div>
          </section>
        </div>
        <div class="sub2-diagnostics-overlay" hidden>
          <section class="sub2-diagnostics-drawer" role="dialog" aria-modal="true" aria-labelledby="sub2-diagnostics-title">
            <div class="sub2-diagnostics-head">
              <div>
                <strong id="sub2-diagnostics-title" class="sub2-diagnostics-title">请求历史 / 路由回放</strong>
                <div class="sub2-diagnostics-subtitle">查看真实请求并按需回放路由；不测活、不自动改路由。</div>
              </div>
              <button type="button" class="sub2-diagnostics-close" title="关闭" aria-label="关闭路由诊断">×</button>
            </div>
            <div class="sub2-diagnostics-body"></div>
          </section>
        </div>
        <div class="sub2-events-overlay" hidden>
          <section class="sub2-events-drawer" role="dialog" aria-modal="true" aria-labelledby="sub2-events-title">
            <div class="sub2-events-head">
              <div>
                <strong id="sub2-events-title" class="sub2-events-title">事件中心 / 可靠性</strong>
                <div class="sub2-events-subtitle">汇总真实 403、429、5xx、冷却与命中变化；不主动测活。</div>
              </div>
              <button type="button" class="sub2-events-close" title="关闭" aria-label="关闭事件中心">×</button>
            </div>
            <div class="sub2-events-body"></div>
          </section>
        </div>
        <div class="sub2-audit-overlay" hidden>
          <section class="sub2-audit-drawer" role="dialog" aria-modal="true" aria-labelledby="sub2-audit-title">
            <div class="sub2-audit-head">
              <div>
                <strong id="sub2-audit-title" class="sub2-audit-title">配置风险审计</strong>
                <div class="sub2-audit-subtitle">检测单点故障、配置异常、主力账号全部受限与容量建议。</div>
              </div>
              <button type="button" class="sub2-audit-close" title="关闭" aria-label="关闭配置审计">×</button>
            </div>
            <div class="sub2-audit-body"></div>
          </section>
        </div>
      `;
      document.body.appendChild(this.root);

      this.summaryElement = this.root.querySelector('.sub2-summary');
      this.listElement = this.root.querySelector('.sub2-list');
      this.statusElement = this.root.querySelector('.sub2-status');
      this.searchElement = this.root.querySelector('.sub2-account-search');
      this.viewElement = this.root.querySelector('.sub2-view');
      this.sortElement = this.root.querySelector('.sub2-sort');
      this.groupFilterEl = this.root.querySelector('.sub2-groupfilter');
      this.groupFilterBtn = this.root.querySelector('.sub2-groupfilter-btn');
      this.groupFilterLabelEl = this.root.querySelector('.sub2-gf-label');
      this.groupFilterSearchEl = this.root.querySelector('.sub2-gf-search');
      this.groupFilterOptionsEl = this.root.querySelector('.sub2-groupfilter-options');
      this.platformFilterEl = this.root.querySelector('.sub2-platform-filter');
      this.healthFilterEl = this.root.querySelector('.sub2-health-filter');
      this.modelOverlayElement = this.root.querySelector('.sub2-model-overlay');
      this.modelTitleElement = this.root.querySelector('.sub2-model-title');
      this.modelSearchElement = this.root.querySelector('.sub2-model-search');
      this.modelSyncButtonElement = this.root.querySelector('.sub2-model-sync');
      this.modelStateElement = this.root.querySelector('.sub2-model-state');
      this.modelListElement = this.root.querySelector('.sub2-model-list');
      this.diagnosticsOverlayElement = this.root.querySelector('.sub2-diagnostics-overlay');
      this.diagnosticsBodyElement = this.root.querySelector('.sub2-diagnostics-body');
      this.eventsOverlayElement = this.root.querySelector('.sub2-events-overlay');
      this.eventsBodyElement = this.root.querySelector('.sub2-events-body');
      this.auditOverlayElement = this.root.querySelector('.sub2-audit-overlay');
      this.auditBodyElement = this.root.querySelector('.sub2-audit-body');

      this.viewElement.value = this.viewMode;
      this.sortElement.value = this.sortMode;
      this.root.querySelector('.sub2-min').addEventListener('click', () => this.setMinimized(true));
      this.root.querySelector('.sub2-audit-open')?.addEventListener('click', () => this.openAuditDrawer());
      this.root.querySelector('.sub2-events-open')?.addEventListener('click', () => this.openEventsDrawer());
      this.root.querySelector('.sub2-diagnostics-open')?.addEventListener('click', () => this.openDiagnosticsDrawer());
      this.root.querySelector('.sub2-refresh').addEventListener('click', () => this.refresh());
      this.searchElement.addEventListener('input', () => {
        this.filterText = this.searchElement.value.trim().toLocaleLowerCase();
        this.renderList();
      });
      this.viewElement.addEventListener('change', () => {
        this.viewMode = this.viewElement.value === 'flat' ? 'flat' : 'group';
        sub2StorageSet('viewMode', this.viewMode);
        this.renderList();
      });
      this.sortElement.addEventListener('change', () => {
        this.sortMode = this.sortElement.value;
        sub2StorageSet('sortMode', this.sortMode);
        this.renderList();
      });

      if (this.healthFilterEl) this.healthFilterEl.value = this.healthFilter || 'all';
      this.platformFilterEl?.addEventListener('change', () => {
        this.platformFilter = this.platformFilterEl.value === 'all' ? '' : this.platformFilterEl.value;
        sub2StorageSet('platformFilter', this.platformFilter);
        this.renderList();
      });
      this.healthFilterEl?.addEventListener('change', () => {
        this.healthFilter = this.healthFilterEl.value === 'all' ? '' : this.healthFilterEl.value;
        sub2StorageSet('healthFilter', this.healthFilter);
        this.renderList();
      });
      this.groupFilterBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        this.setGroupFilterOpen(!this.groupFilterOpen);
      });
      this.groupFilterSearchEl?.addEventListener('input', () => {
        this.groupFilterSearchText = this.groupFilterSearchEl.value.trim().toLocaleLowerCase();
        this.renderGroupFilterOptions();
      });
      // 点击面板外部时关闭分组下拉。
      this.outsideClickHandler = (event) => {
        if (this.groupFilterOpen && this.groupFilterEl && !this.groupFilterEl.contains(event.target)) {
          this.setGroupFilterOpen(false);
        }
      };
      document.addEventListener('click', this.outsideClickHandler);

      this.root.querySelector('.sub2-model-close')?.addEventListener('click', () => this.closeModelDrawer());
      this.modelOverlayElement?.addEventListener('click', (event) => {
        if (event.target === this.modelOverlayElement) this.closeModelDrawer();
      });
      this.modelSearchElement?.addEventListener('input', () => {
        this.modelFilterText = this.modelSearchElement.value.trim().toLocaleLowerCase();
        this.renderModelDrawer();
      });
      this.modelSyncButtonElement?.addEventListener('click', () => this.handleSyncModels());
      this.root.querySelector('.sub2-diagnostics-close')?.addEventListener('click', () => this.closeDiagnosticsDrawer());
      this.diagnosticsOverlayElement?.addEventListener('click', (event) => {
        if (event.target === this.diagnosticsOverlayElement) this.closeDiagnosticsDrawer();
      });
      this.root.querySelector('.sub2-events-close')?.addEventListener('click', () => this.closeEventsDrawer());
      this.eventsOverlayElement?.addEventListener('click', (event) => {
        if (event.target === this.eventsOverlayElement) this.closeEventsDrawer();
      });
      this.root.querySelector('.sub2-audit-close')?.addEventListener('click', () => this.closeAuditDrawer());
      this.auditOverlayElement?.addEventListener('click', (event) => {
        if (event.target === this.auditOverlayElement) this.closeAuditDrawer();
      });

      this.applyMinimized();
    }

    hasOpenQuotaEditor() {
      return Boolean(this.root?.querySelector('.sub2-quota-editor:not([hidden])'));
    }

    hasOpenCapacityEditor() {
      return Boolean(this.root?.querySelector('.sub2-capacity-editor:not([hidden])'));
    }

    isAccountInteractionActive() {
      return this.quotaSaving
        || this.capacitySaving
        || this.hasOpenQuotaEditor()
        || this.hasOpenCapacityEditor();
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
      if (this.loading) {
        this.pendingRefresh = true;
        return;
      }
      if (this.isAccountInteractionActive()) return;

      this.pendingRefresh = false;
      const requestSequence = ++this.refreshRequestSequence;
      this.loading = true;
      let shouldRender = false;
      try {
        const [accounts, groups] = await Promise.all([
          sub2FetchAccounts(),
          sub2FetchGroups().catch(() => null),
        ]);
        const ids = accounts.map((account) => account.id).filter((id) => Number.isFinite(Number(id)));
        let nextStatsById = this.statsById || {};
        try {
          nextStatsById = await sub2FetchTodayStats(ids);
        } catch {
          nextStatsById = this.statsById || {};
        }

        if (requestSequence !== this.refreshRequestSequence || this.isAccountInteractionActive()) return;

        this.accounts = accounts;
        if (groups !== null) this.groupsById = sub2BuildGroupIndex(groups);
        this.statsById = nextStatsById;
        this.latestHit = sub2ResolveLatestHit(
          this.accounts,
          this.routingRequestsAvailable ? this.recentRequest : null,
          !this.routingRequestsAvailable,
        );
        this.lastError = '';
        this.lastUpdatedAt = Date.now();
        shouldRender = true;
      } catch (error) {
        if (requestSequence === this.refreshRequestSequence && !this.isAccountInteractionActive()) {
          this.lastError = error?.status === 401
            ? '登录已失效，请重新登录 sub2 后台后再刷新。'
            : `读取失败：${error?.message || error}`;
          shouldRender = true;
        }
      } finally {
        this.loading = false;
        if (shouldRender) this.render();
        if (shouldRender && requestSequence === this.refreshRequestSequence) {
          this.refreshRoutingActivity(requestSequence);
        }
        if (this.pendingRefresh && !this.isAccountInteractionActive()) {
          this.pendingRefresh = false;
          window.setTimeout(() => this.refresh(), 0);
        }
      }
    }

    async refreshRoutingActivity(accountRequestSequence) {
      const routingRequestSequence = ++this.routingRequestSequence;
      const routingActivity = await sub2FetchRecentRoutingActivity();
      if (
        routingRequestSequence !== this.routingRequestSequence
        || accountRequestSequence !== this.refreshRequestSequence
        || this.isAccountInteractionActive()
      ) {
        return;
      }

      this.routingRequestsAvailable = routingActivity.requestsAvailable;
      this.routingErrorsAvailable = routingActivity.errorsAvailable;
      this.routingErrorsComplete = routingActivity.errorsComplete;
      this.recentRequest = routingActivity.requestsAvailable ? routingActivity.recentRequest : null;
      this.requestHistory = routingActivity.requestsAvailable ? routingActivity.requestHistory : [];
      if (
        this.selectedDiagnosticsRequestKey
        && !this.requestHistory.some(
          (requestItem) => sub2GetRequestHistoryKey(requestItem) === this.selectedDiagnosticsRequestKey,
        )
      ) {
        this.selectedDiagnosticsRequestKey = '';
        this.selectedRouteReplay = null;
      }
      this.recentRoutingErrorByAccountId = routingActivity.errorsAvailable
        ? routingActivity.errorByAccountId
        : new Map();
      this.routeChain = routingActivity.routeChain || { events: [], detailLevel: 'success-only' };
      this.routeDetailsAvailable = routingActivity.routeDetailsAvailable;
      this.concurrencyAvailable = routingActivity.concurrencyAvailable;
      if (routingActivity.concurrencySnapshot) {
        this.concurrencyEnabled = routingActivity.concurrencySnapshot.enabled;
        this.concurrencyTimestamp = routingActivity.concurrencySnapshot.timestamp || Date.now();
        this.concurrencyByAccountId = routingActivity.concurrencySnapshot.byAccountId;
        this.concurrencyRecordsByAccountId = routingActivity.concurrencySnapshot.recordsByAccountId;
      } else if (!routingActivity.concurrencyAvailable) {
        this.concurrencyEnabled = false;
        this.concurrencyByAccountId = new Map();
        this.concurrencyRecordsByAccountId = new Map();
      }
      this.latestHit = sub2ResolveLatestHit(
        this.accounts,
        this.recentRequest,
        !this.routingRequestsAvailable,
      );
      this.recordOperationalEvents(routingActivity);
      this.renderSummary();
      this.renderList();
      if (this.diagnosticsOpen) this.renderDiagnosticsDrawer();
      if (this.eventsOpen) {
        this.renderEventsDrawer();
        if (Date.now() - this.lastReliabilityRefreshAt >= SUB2_RELIABILITY_REFRESH_MS) {
          this.refreshReliabilityActivity();
        }
      }
    }

    render() {
      this.renderSummary();
      this.renderFilters();
      this.renderList();
      this.renderStatus();
      if (this.diagnosticsOpen) this.renderDiagnosticsDrawer();
      if (this.eventsOpen) this.renderEventsDrawer();
    }

    renderFilters() {
      this.renderPlatformFilterOptions();
      this.renderGroupFilterOptions();
      this.updateGroupFilterLabel();
    }

    renderPlatformFilterOptions() {
      if (!this.platformFilterEl) return;
      const platforms = sub2CollectPlatforms(this.accounts);
      const current = this.platformFilter || 'all';
      const options = ['<option value="all">全部平台</option>']
        .concat(platforms.map((platform) => {
          const safe = platform.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
          return `<option value="${safe}">${safe}</option>`;
        }));
      this.platformFilterEl.innerHTML = options.join('');
      this.platformFilterEl.value = platforms.includes(this.platformFilter) ? this.platformFilter : 'all';
      if (this.platformFilterEl.value === 'all') this.platformFilter = '';
    }

    updateGroupFilterLabel() {
      if (!this.groupFilterLabelEl) return;
      if (!this.groupFilter) {
        this.groupFilterLabelEl.textContent = '全部分组';
        return;
      }
      if (this.groupFilter === 'ungrouped') {
        this.groupFilterLabelEl.textContent = '未分配分组';
        return;
      }
      const options = sub2CollectGroupOptions(this.accounts, this.groupsById);
      const matched = options.find((option) => option.key === this.groupFilter);
      this.groupFilterLabelEl.textContent = matched ? matched.name : '全部分组';
      if (!matched) this.groupFilter = '';
    }

    setGroupFilterOpen(open) {
      this.groupFilterOpen = open === true;
      if (this.groupFilterEl) this.groupFilterEl.classList.toggle('open', this.groupFilterOpen);
      if (this.groupFilterOpen) {
        this.renderGroupFilterOptions();
        this.groupFilterSearchEl?.focus();
      }
    }

    renderGroupFilterOptions() {
      if (!this.groupFilterOptionsEl) return;
      const options = sub2CollectGroupOptions(this.accounts, this.groupsById);
      const search = this.groupFilterSearchText || '';
      const filtered = options.filter((option) => option.special || !search || option.name.toLocaleLowerCase().includes(search));
      if (!filtered.length) {
        this.groupFilterOptionsEl.innerHTML = '<div class="sub2-gf-empty">没有匹配的分组</div>';
        return;
      }
      this.groupFilterOptionsEl.textContent = '';
      for (const option of filtered) {
        const item = document.createElement('div');
        item.className = 'sub2-gf-option' + (option.key === this.groupFilter ? ' active' : '');
        const label = document.createElement('span');
        label.textContent = option.name;
        const count = document.createElement('span');
        count.className = 'sub2-gf-count';
        count.textContent = String(option.count);
        item.append(label, count);
        item.addEventListener('click', () => {
          this.groupFilter = option.key;
          sub2StorageSet('groupFilter', this.groupFilter);
          this.setGroupFilterOpen(false);
          this.updateGroupFilterLabel();
          this.renderList();
        });
        this.groupFilterOptionsEl.appendChild(item);
      }
    }

    renderSummary() {
      if (!this.summaryElement) return;
      const now = Date.now();
      const counts = { ok: 0, warn: 0, paused: 0, down: 0 };
      for (const account of this.accounts) {
        counts[sub2ComputeHealth(account, now).tone] += 1;
      }
      const concurrencySummary = sub2SummarizeConcurrency(this.concurrencyByAccountId);
      const concurrencyLabel = this.concurrencyAvailable && this.concurrencyEnabled
        ? `并发 ${concurrencySummary.currentInUse} / ${concurrencySummary.maxCapacity}${concurrencySummary.waitingInQueue > 0 ? ` · 排队 ${concurrencySummary.waitingInQueue}` : ''}`
        : this.concurrencyAvailable
          ? '并发统计未启用'
          : '并发统计不可用';
      const concurrencyTone = this.concurrencyAvailable && this.concurrencyEnabled ? 'info' : 'muted';
      this.summaryElement.innerHTML = `
        <span class="sub2-chip ok">正常 ${counts.ok}</span>
        <span class="sub2-chip warn">注意 ${counts.warn}</span>
        <span class="sub2-chip down">不可用 ${counts.down}</span>
        <span class="sub2-chip paused">已停用 ${counts.paused}</span>
        <span class="sub2-chip ${concurrencyTone}">${concurrencyLabel}</span>
      `;
    }

    renderList() {
      if (!this.listElement) return;
      this.listElement.classList.toggle('sub2-flat-list', this.viewMode === 'flat');
      // 记录当前滚动位置，重建 DOM 后恢复，避免列表跳动。
      const savedScrollTop = this.listElement.scrollTop;
      const now = Date.now();
      const filters = {
        groupFilter: this.groupFilter,
        platformFilter: this.platformFilter,
        healthFilter: this.healthFilter,
        filterText: this.filterText,
      };
      const visibleAccounts = this.accounts.filter((account) => sub2AccountMatchesActiveFilters(
        account,
        sub2GetGroupMemberships(account, this.groupsById),
        filters,
        now,
      ));

      if (this.viewMode === 'group') {
        let sections = sub2BuildGroupedSections(visibleAccounts, this.statsById, this.sortMode, '', now, this.groupsById);
        // 指定具体分组时，只保留该分节（账号可能同时属于多个分组）。
        if (this.groupFilter === 'ungrouped') {
          sections = sections.filter((section) => section.ungrouped);
        } else if (this.groupFilter) {
          sections = sections.filter((section) => section.groupKey === this.groupFilter);
        }
        if (!sections.length) {
          this.listElement.innerHTML = '<div class="sub2-reasons" style="padding:10px;">没有匹配的账号或分组。</div>';
          return;
        }
        this.listElement.textContent = '';
        for (const section of sections) {
          this.listElement.appendChild(this.buildGroupSection(section, now));
        }
        this.listElement.scrollTop = savedScrollTop;
        return;
      }

      const rows = sub2SortAccounts(visibleAccounts, this.statsById, this.sortMode, now);
      if (!rows.length) {
        this.listElement.innerHTML = '<div class="sub2-reasons" style="padding:10px;">没有匹配的账号。</div>';
        return;
      }
      this.listElement.textContent = '';
      for (const account of rows) {
        this.listElement.appendChild(this.buildRow(account, now));
      }
      this.listElement.scrollTop = savedScrollTop;
    }

    buildGroupSection(section, now) {
      const healthCounts = { ok: 0, warn: 0, paused: 0, down: 0 };
      for (const entry of section.entries) {
        healthCounts[sub2ComputeHealth(entry.account, now).tone] += 1;
      }

      const groupSection = document.createElement('section');
      groupSection.className = 'sub2-group';

      const header = document.createElement('div');
      header.className = 'sub2-group-head';
      const title = document.createElement('div');
      title.className = 'sub2-group-title';
      const name = document.createElement('strong');
      name.textContent = section.name;
      title.appendChild(name);
      if (section.platform) {
        const platform = document.createElement('span');
        platform.className = 'sub2-group-platform';
        platform.textContent = section.platform;
        title.appendChild(platform);
      }

      const summary = document.createElement('div');
      summary.className = 'sub2-group-summary';
      summary.textContent = `${section.entries.length} 个账号 · 不可用 ${healthCounts.down} · 注意 ${healthCounts.warn} · 停用 ${healthCounts.paused}`;
      header.append(title, summary);

      const groupList = document.createElement('div');
      groupList.className = 'sub2-group-list';
      for (const entry of section.entries) {
        groupList.appendChild(this.buildRow(entry.account, now, entry.membership));
      }
      groupSection.append(header, groupList);
      return groupSection;
    }

    buildRow(account, now, groupMembership = null) {
      const health = sub2ComputeHealth(account, now);
      const stats = this.statsById?.[account.id] || {};
      const busy = this.busyIds.has(account.id);

      const row = document.createElement('div');
      row.className = `sub2-row tone-${health.tone}`;

      const top = document.createElement('div');
      top.className = 'sub2-row-top';
      const accountName = String(account.name || `账号 ${account.id}`).trim() || `账号 ${account.id}`;
      const upstreamBaseUrl = sub2GetUpstreamBaseUrl(account);
      const upstreamWebsiteUrl = sub2GetUpstreamWebsiteUrl(account);
      const name = document.createElement(upstreamWebsiteUrl ? 'a' : 'span');
      name.className = upstreamWebsiteUrl ? 'sub2-name sub2-name-link' : 'sub2-name';
      name.textContent = accountName;
      name.title = upstreamWebsiteUrl
        ? `打开上游网站：${upstreamBaseUrl}`
        : accountName;
      if (upstreamWebsiteUrl) {
        name.href = upstreamWebsiteUrl;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
      }
      // 只有名称文字和外链图标可点击；外层占据剩余宽度，避免整段空白成为链接热区。
      const nameSlot = document.createElement('div');
      nameSlot.className = 'sub2-name-slot';
      nameSlot.appendChild(name);
      const priority = document.createElement('span');
      priority.className = 'sub2-priority';
      priority.title = '账号优先级：数值越小越优先';
      const priorityLabel = document.createElement('span');
      priorityLabel.textContent = 'P';
      const priorityValue = document.createElement('strong');
      priorityValue.textContent = String(Number(account.priority) || 0);
      priority.append(priorityLabel, priorityValue);
      const badge = document.createElement('span');
      badge.className = `sub2-badge ${health.tone}`;
      badge.textContent = SUB2_TONE_LABELS[health.tone];
      const platform = document.createElement('span');
      platform.className = 'sub2-platform';
      platform.textContent = String(account.platform || '');
      top.append(nameSlot, priority);
      if (this.latestHit && Number(account.id) === this.latestHit.accountId) {
        const latestHitBadge = document.createElement('button');
        latestHitBadge.type = 'button';
        latestHitBadge.className = 'sub2-hit-badge';
        latestHitBadge.textContent = '最近命中';
        latestHitBadge.title = `最近成功请求：${sub2FormatRelative(this.latestHit.createdAt, now)}；点击查看路由诊断`;
        latestHitBadge.addEventListener('click', () => this.openDiagnosticsDrawer());
        top.appendChild(latestHitBadge);
      }
      top.append(badge, platform);

      const meta = document.createElement('div');
      meta.className = 'sub2-meta';
      const requests = Number(stats.requests) || 0;
      const cost = sub2FormatCost(stats.cost);
      const todayUsage = document.createElement('span');
      todayUsage.textContent = `今日 ${requests} 次 / $${cost}`;
      const lastUsed = document.createElement('span');
      lastUsed.textContent = `最近使用 ${sub2FormatRelative(account.last_used_at, now)}`;
      meta.append(todayUsage, lastUsed);

      const displayConcurrency = sub2ResolveAccountConcurrency(
        account.id,
        groupMembership?.groupId ?? this.latestHit?.groupId,
        this.concurrencyByAccountId,
        this.concurrencyRecordsByAccountId,
      );
      if (this.concurrencyAvailable && this.concurrencyEnabled && displayConcurrency) {
        const currentInUse = displayConcurrency.currentInUse ?? 0;
        const maxCapacity = displayConcurrency.maxCapacity ?? 0;
        const waitingInQueue = displayConcurrency.waitingInQueue ?? 0;
        const loadPercentage = displayConcurrency.loadPercentage;
        const utilization = maxCapacity > 0 ? currentInUse / maxCapacity : 0;
        const loadLabel = Number.isFinite(loadPercentage) ? ` · ${Math.round(loadPercentage)}%` : '';
        const capacityState = document.createElement('span');
        capacityState.className = 'sub2-capacity-state'
          + (utilization >= 1 ? ' down' : utilization >= 0.8 || waitingInQueue > 0 ? ' warn' : '');
        capacityState.textContent = maxCapacity > 0
          ? `容量 ${currentInUse} / ${maxCapacity}${loadLabel}${waitingInQueue > 0 ? ` · 排队 ${waitingInQueue}` : ''}`
          : `并发 ${currentInUse}${loadLabel}${waitingInQueue > 0 ? ` · 排队 ${waitingInQueue}` : ''}`;
        const snapshotAge = this.concurrencyTimestamp
          ? sub2FormatRelative(this.concurrencyTimestamp, now)
          : '时间未知';
        capacityState.title = `sub2 当前并发快照（${snapshotAge}），不是历史请求发生时的并发`;
        meta.appendChild(capacityState);
      }

      const supportsDailyQuota = sub2SupportsDailyQuota(account);
      const dailyLimit = sub2GetNumericAccountField(account, 'quota_daily_limit');
      const dailyUsed = sub2GetNumericAccountField(account, 'quota_daily_used');
      if (supportsDailyQuota) {
        const quotaSummary = document.createElement('span');
        const quotaUtilization = dailyLimit > 0 ? dailyUsed / dailyLimit : 0;
        quotaSummary.className = 'sub2-quota-summary'
          + (quotaUtilization >= 1 ? ' down' : quotaUtilization >= 0.8 ? ' warn' : '');
        quotaSummary.textContent = dailyLimit > 0
          ? `日配额 $${sub2FormatCost(dailyUsed)} / $${sub2FormatCost(dailyLimit)}`
          : '日配额 未限制';
        quotaSummary.title = dailyLimit > 0
          ? '达到日限额后账号暂停调度；默认从首次使用起滚动 24 小时重置'
          : '当前未设置每日费用上限';
        meta.appendChild(quotaSummary);
      }

      const poolModeState = sub2GetPoolModeState(account);
      if (poolModeState !== null) {
        const poolMode = document.createElement('span');
        poolMode.className = 'sub2-pool-state';
        poolMode.textContent = `池模式 ${poolModeState ? '开' : '关'}`;
        poolMode.title = poolModeState
          ? '适用于上游自身是账号池的场景；401/403/429 会同账号重试且不标记本地账号错误'
          : '普通单 Key 上游通常应保持关闭';
        meta.appendChild(poolMode);
      }
      const groupDescription = document.createElement('span');
      groupDescription.className = 'sub2-group-membership';
      if (groupMembership) {
        const groupPriority = groupMembership.priority === null ? '' : ` · 组内优先级 ${groupMembership.priority}`;
        groupDescription.textContent = `分组 ${groupMembership.name}${groupPriority}`;
      } else {
        const memberships = sub2GetGroupMemberships(account, this.groupsById);
        if (!memberships.length) {
          groupDescription.textContent = '未分组';
        } else {
          const membershipLabels = memberships.map((membership) => membership.priority === null
            ? membership.name
            : `${membership.name} · 组内优先级 ${membership.priority}`);
          groupDescription.textContent = `分组 ${membershipLabels.join(' / ')}`;
        }
      }
      meta.appendChild(groupDescription);

      const reasons = document.createElement('div');
      reasons.className = 'sub2-reasons';
      reasons.textContent = health.reasons.join('；');

      const requestConcurrency = sub2ResolveAccountConcurrency(
        account.id,
        this.latestHit?.groupId,
        this.concurrencyByAccountId,
        this.concurrencyRecordsByAccountId,
      );
      const routingExplanation = sub2BuildRoutingExplanation(account, {
        latestHit: this.latestHit,
        latestHitEffectivePriority: this.latestHit
          ? sub2GetEffectivePriority(
            this.accounts.find((candidateAccount) => Number(candidateAccount.id) === this.latestHit.accountId),
            this.latestHit.groupId,
            this.groupsById,
          )
          : null,
        recentError: this.recentRoutingErrorByAccountId.get(Number(account.id)) || null,
        groupsById: this.groupsById,
        errorsAvailable: this.routingErrorsAvailable && this.routingErrorsComplete,
        routeChain: this.routeChain,
        concurrency: requestConcurrency,
        concurrencyAvailable: this.concurrencyAvailable,
        concurrencyEnabled: this.concurrencyEnabled,
        savedModelState: this.savedModelsByAccountId.get(Number(account.id)) || null,
      }, now);
      let routingNote = null;
      if (routingExplanation) {
        routingNote = document.createElement('div');
        routingNote.className = `sub2-routing-note ${routingExplanation.tone}`;
        const evidence = document.createElement('span');
        evidence.className = 'sub2-routing-evidence';
        evidence.textContent = routingExplanation.evidence;
        const explanationText = document.createElement('span');
        explanationText.textContent = routingExplanation.text;
        routingNote.append(evidence, explanationText);
      }

      const actions = document.createElement('div');
      actions.className = 'sub2-actions';

      const modelsBtn = document.createElement('button');
      modelsBtn.className = 'sub2-btn primary';
      modelsBtn.textContent = '模型';
      modelsBtn.title = '先查看 sub2 已保存的模型；需要时可在抽屉中手动拉取上游';
      modelsBtn.disabled = busy;
      modelsBtn.addEventListener('click', () => this.openModelDrawer(account));
      actions.appendChild(modelsBtn);

      const configuredCapacity = Number.isInteger(Number(account.concurrency))
        ? Number(account.concurrency)
        : 0;
      const currentCapacityUsage = displayConcurrency?.currentInUse ?? 0;
      const capacityBtn = document.createElement('button');
      capacityBtn.className = 'sub2-btn primary';
      capacityBtn.textContent = '容量';
      capacityBtn.title = `人工调整账号并发容量；当前配置 ${configuredCapacity}`;
      capacityBtn.disabled = busy;
      actions.appendChild(capacityBtn);

      const capacityEditor = document.createElement('div');
      capacityEditor.className = 'sub2-capacity-editor';
      capacityEditor.hidden = true;
      const decreaseCapacityButton = document.createElement('button');
      decreaseCapacityButton.type = 'button';
      decreaseCapacityButton.className = 'sub2-capacity-step';
      decreaseCapacityButton.textContent = '−';
      decreaseCapacityButton.title = '输入值减 1（不会立即保存）';
      const capacityInput = document.createElement('input');
      capacityInput.className = 'sub2-capacity-input';
      capacityInput.type = 'number';
      capacityInput.min = '1';
      capacityInput.max = String(SUB2_CAPACITY_MAX);
      capacityInput.step = '1';
      capacityInput.value = String(Math.max(1, configuredCapacity));
      capacityInput.setAttribute('aria-label', '账号并发容量');
      const increaseCapacityButton = document.createElement('button');
      increaseCapacityButton.type = 'button';
      increaseCapacityButton.className = 'sub2-capacity-step';
      increaseCapacityButton.textContent = '+';
      increaseCapacityButton.title = '输入值加 1（不会立即保存）';
      const applyCapacityButton = document.createElement('button');
      applyCapacityButton.type = 'button';
      applyCapacityButton.className = 'sub2-btn primary';
      applyCapacityButton.textContent = '应用';
      applyCapacityButton.disabled = busy;
      const capacityHelp = document.createElement('div');
      capacityHelp.className = 'sub2-capacity-help';
      capacityHelp.textContent = `配置 ${configuredCapacity} · 当前占用 ${currentCapacityUsage}`
        + (displayConcurrency?.waitingInQueue > 0 ? ` · 排队 ${displayConcurrency.waitingInQueue}` : '')
        + '；加减只改输入，点击“应用”才写入。';
      const capacityWarning = document.createElement('div');
      capacityWarning.className = 'sub2-capacity-warning';

      const updateCapacityWarning = () => {
        const parsedCapacity = sub2ParseCapacityInput(capacityInput.value);
        if (parsedCapacity.error) {
          capacityWarning.textContent = parsedCapacity.error;
        } else if (parsedCapacity.value < currentCapacityUsage) {
          capacityWarning.textContent = '新容量低于当前占用；不会中断已有请求，但新请求可能暂时排队。';
        } else if (parsedCapacity.value === configuredCapacity) {
          capacityWarning.textContent = '输入值与当前配置相同。';
        } else {
          capacityWarning.textContent = '';
        }
      };
      const stepCapacityInput = (delta) => {
        const parsedCapacity = sub2ParseCapacityInput(capacityInput.value);
        const currentInputValue = parsedCapacity.error ? Math.max(1, configuredCapacity) : parsedCapacity.value;
        capacityInput.value = String(Math.min(SUB2_CAPACITY_MAX, Math.max(1, currentInputValue + delta)));
        updateCapacityWarning();
      };
      decreaseCapacityButton.addEventListener('click', () => stepCapacityInput(-1));
      increaseCapacityButton.addEventListener('click', () => stepCapacityInput(1));
      capacityInput.addEventListener('input', updateCapacityWarning);
      capacityInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.handleCapacity(account, capacityInput.value);
      });
      applyCapacityButton.addEventListener('click', () => this.handleCapacity(account, capacityInput.value));
      capacityEditor.append(
        decreaseCapacityButton,
        capacityInput,
        increaseCapacityButton,
        applyCapacityButton,
        capacityHelp,
        capacityWarning,
      );
      capacityBtn.addEventListener('click', () => {
        const editorWillOpen = capacityEditor.hidden;
        capacityEditor.hidden = !editorWillOpen;
        if (editorWillOpen) {
          this.refreshRequestSequence += 1;
          updateCapacityWarning();
          capacityInput.focus();
          capacityInput.select();
        } else {
          this.refresh();
        }
      });

      let quotaEditor = null;
      let quotaInput = null;
      if (supportsDailyQuota) {
        const quotaBtn = document.createElement('button');
        quotaBtn.className = 'sub2-btn primary';
        quotaBtn.textContent = '日配额';
        quotaBtn.title = '设置每日费用上限（美元）';
        quotaBtn.disabled = busy;
        actions.appendChild(quotaBtn);

        quotaEditor = document.createElement('div');
        quotaEditor.className = 'sub2-quota-editor';
        quotaEditor.hidden = true;
        const inputWrap = document.createElement('label');
        inputWrap.className = 'sub2-quota-input-wrap';
        const prefix = document.createElement('span');
        prefix.className = 'sub2-quota-prefix';
        prefix.textContent = '$';
        quotaInput = document.createElement('input');
        quotaInput.className = 'sub2-quota-input';
        quotaInput.type = 'number';
        quotaInput.min = '0.01';
        quotaInput.step = '0.01';
        quotaInput.placeholder = '每日上限';
        quotaInput.value = dailyLimit > 0 ? String(dailyLimit) : '';
        inputWrap.append(prefix, quotaInput);

        const saveQuotaBtn = document.createElement('button');
        saveQuotaBtn.className = 'sub2-btn primary';
        saveQuotaBtn.textContent = '保存';
        saveQuotaBtn.disabled = busy;
        saveQuotaBtn.addEventListener('click', () => this.handleDailyQuota(account, quotaInput.value));

        const clearQuotaBtn = document.createElement('button');
        clearQuotaBtn.className = 'sub2-btn danger';
        clearQuotaBtn.textContent = '取消限制';
        clearQuotaBtn.disabled = busy || dailyLimit <= 0;
        clearQuotaBtn.addEventListener('click', () => this.handleDailyQuota(account, null));

        const quotaHelp = document.createElement('div');
        quotaHelp.className = 'sub2-quota-help';
        quotaHelp.textContent = '单位：美元；达到限额后暂停调度，默认滚动 24 小时重置。';
        quotaEditor.append(inputWrap, saveQuotaBtn, clearQuotaBtn, quotaHelp);
        quotaBtn.addEventListener('click', () => {
          const editorWillOpen = quotaEditor.hidden;
          quotaEditor.hidden = !editorWillOpen;
          if (editorWillOpen) {
            // 使已经发出的自动刷新失效，避免响应回来后重建列表并清空正在输入的金额。
            this.refreshRequestSequence += 1;
            quotaInput.focus();
          } else {
            this.refresh();
          }
        });
        quotaInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') this.handleDailyQuota(account, quotaInput.value);
        });
      }

      const upBtn = document.createElement('button');
      upBtn.className = 'sub2-btn';
      upBtn.textContent = '优先级升';
      upBtn.title = '数值 -1（更优先被调度）';
      upBtn.disabled = busy;
      upBtn.addEventListener('click', () => this.handlePriority(account, -1));
      actions.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.className = 'sub2-btn';
      downBtn.textContent = '优先级降';
      downBtn.title = '数值 +1（更靠后被调度）';
      downBtn.disabled = busy;
      downBtn.addEventListener('click', () => this.handlePriority(account, 1));
      actions.appendChild(downBtn);

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

      row.append(top, meta, reasons);
      if (routingNote) row.appendChild(routingNote);
      row.appendChild(actions);
      if (quotaEditor) row.appendChild(quotaEditor);
      row.appendChild(capacityEditor);
      return row;
    }

    recordOperationalEvents(routingActivity) {
      const now = Date.now();
      const currentObservationSnapshot = sub2BuildObservationSnapshot(
        this.accounts,
        routingActivity?.requestsAvailable ? routingActivity.recentRequest : null,
        now,
      );
      if (!routingActivity?.requestsAvailable && this.eventObservationSnapshot?.latestHit) {
        currentObservationSnapshot.latestHit = this.eventObservationSnapshot.latestHit;
      }
      const transitionEvents = sub2BuildObservationTransitionEvents(
        this.eventObservationSnapshot,
        currentObservationSnapshot,
        now,
      );
      const requestEvents = sub2BuildRequestStatusEvents(
        routingActivity?.requestsAvailable ? routingActivity.requestHistory : [],
        routingActivity?.errorsAvailable ? routingActivity.routingErrors : [],
      );
      this.localEvents = sub2MergeLocalEvents(
        this.localEvents,
        requestEvents.concat(transitionEvents),
        this.eventRetentionDays,
        now,
      );
      this.eventObservationSnapshot = currentObservationSnapshot;
      sub2StorageSet('localEvents', this.localEvents);
      sub2StorageSet('eventObservationSnapshot', this.eventObservationSnapshot);
    }

    async refreshReliabilityActivity(force = false) {
      const snapshotIsFresh = this.reliabilitySnapshot
        && Date.now() - this.lastReliabilityRefreshAt < SUB2_RELIABILITY_REFRESH_MS;
      if (this.reliabilityLoading || (!force && snapshotIsFresh)) return;

      const requestSequence = ++this.reliabilityRequestSequence;
      this.reliabilityLoading = true;
      this.reliabilityError = '';
      if (this.eventsOpen) this.renderEventsDrawer();
      try {
        const reliabilitySnapshot = await sub2FetchReliabilityActivity();
        if (requestSequence !== this.reliabilityRequestSequence) return;
        this.reliabilitySnapshot = reliabilitySnapshot;
        this.lastReliabilityRefreshAt = Date.now();
        this.localEvents = sub2MergeLocalEvents(
          this.localEvents,
          sub2BuildRequestStatusEvents(
            reliabilitySnapshot.requestHistory,
            reliabilitySnapshot.routingErrors,
          ),
          this.eventRetentionDays,
          this.lastReliabilityRefreshAt,
        );
        sub2StorageSet('localEvents', this.localEvents);
      } catch (error) {
        if (requestSequence === this.reliabilityRequestSequence) {
          this.reliabilityError = `24 小时可靠性读取失败：${error?.message || error}`;
        }
      } finally {
        if (requestSequence === this.reliabilityRequestSequence) {
          this.reliabilityLoading = false;
          if (this.eventsOpen) this.renderEventsDrawer();
        }
      }
    }

    openEventsDrawer() {
      this.closeDiagnosticsDrawer();
      this.closeModelDrawer();
      this.eventsOpen = true;
      if (this.eventsOverlayElement) this.eventsOverlayElement.hidden = false;
      if (this.eventsBodyElement) this.eventsBodyElement.scrollTop = 0;
      this.renderEventsDrawer();
      this.refreshReliabilityActivity(!this.reliabilitySnapshot);
    }

    closeEventsDrawer() {
      this.eventsOpen = false;
      if (this.eventsOverlayElement) this.eventsOverlayElement.hidden = true;
    }

    openAuditDrawer() {
      this.closeDiagnosticsDrawer();
      this.closeEventsDrawer();
      this.closeModelDrawer();
      this.auditOpen = true;
      if (this.auditOverlayElement) this.auditOverlayElement.hidden = false;
      if (this.auditBodyElement) this.auditBodyElement.scrollTop = 0;
      this.renderAuditDrawer();
    }

    closeAuditDrawer() {
      this.auditOpen = false;
      if (this.auditOverlayElement) this.auditOverlayElement.hidden = true;
    }

    setEventRetentionDays(rawRetentionDays) {
      this.eventRetentionDays = sub2NormalizeEventRetentionDays(rawRetentionDays);
      this.localEvents = sub2PruneLocalEvents(this.localEvents, this.eventRetentionDays);
      sub2StorageSet('eventRetentionDays', this.eventRetentionDays);
      sub2StorageSet('localEvents', this.localEvents);
      this.renderEventsDrawer();
    }

    clearLocalEvents() {
      this.localEvents = [];
      sub2StorageSet('localEvents', this.localEvents);
      this.renderEventsDrawer();
    }

    renderEventsDrawer() {
      if (!this.eventsOpen || !this.eventsOverlayElement || !this.eventsBodyElement) return;
      this.eventsOverlayElement.hidden = false;
      const savedScrollTop = this.eventsBodyElement.scrollTop;
      const now = Date.now();
      this.eventsBodyElement.textContent = '';

      const reliabilityCard = document.createElement('section');
      reliabilityCard.className = 'sub2-events-card';
      const reliabilityTitle = document.createElement('h3');
      reliabilityTitle.textContent = '近 24 小时可靠性';
      reliabilityCard.appendChild(reliabilityTitle);
      const reliabilitySnapshot = this.reliabilitySnapshot;
      if (!reliabilitySnapshot) {
        const reliabilityState = document.createElement('div');
        reliabilityState.className = 'sub2-diagnostics-note';
        reliabilityState.textContent = this.reliabilityLoading
          ? '正在读取近 24 小时真实请求与故障转移摘要…'
          : this.reliabilityError || '打开事件中心后按需读取近 24 小时可靠性统计。';
        reliabilityCard.appendChild(reliabilityState);
      } else {
        const reliabilityGrid = document.createElement('div');
        reliabilityGrid.className = 'sub2-reliability-grid';
        const reliabilityMetrics = [
          {
            value: reliabilitySnapshot.successRate === null
              ? '--'
              : `${reliabilitySnapshot.successRate.toFixed(1)}%`,
            label: `成功 ${reliabilitySnapshot.successCount} / 请求 ${reliabilitySnapshot.requestCount}`,
          },
          {
            value: String(reliabilitySnapshot.failoverCount),
            label: reliabilitySnapshot.failoverCoverageComplete ? '故障转移成功次数' : '已识别故障转移（下限）',
          },
          {
            value: String(reliabilitySnapshot.failureCount),
            label: '最终失败请求',
          },
          {
            value: `${reliabilitySnapshot.trackedStatusCounts[429]} / ${reliabilitySnapshot.trackedStatusCounts[403]} / ${reliabilitySnapshot.trackedStatusCounts['5xx']}`,
            label: '请求级 429 / 403 / 5xx',
          },
        ];
        for (const reliabilityMetric of reliabilityMetrics) {
          const metricElement = document.createElement('div');
          metricElement.className = 'sub2-reliability-metric';
          const metricValue = document.createElement('span');
          metricValue.className = 'sub2-reliability-value';
          metricValue.textContent = reliabilityMetric.value;
          const metricLabel = document.createElement('span');
          metricLabel.className = 'sub2-reliability-label';
          metricLabel.textContent = reliabilityMetric.label;
          metricElement.append(metricValue, metricLabel);
          reliabilityGrid.appendChild(metricElement);
        }
        const coverageNote = document.createElement('div');
        coverageNote.className = 'sub2-diagnostics-note';
        const requestCoverageLabel = reliabilitySnapshot.requestCoverageComplete
          ? '请求记录覆盖完整'
          : `请求超过单次 ${SUB2_RELIABILITY_HISTORY_LIMIT} 条读取上限，统计仅代表已读取样本`;
        const failoverCoverageLabel = reliabilitySnapshot.failoverCoverageComplete
          ? '故障转移关联覆盖完整'
          : '错误摘要不完整，故障转移次数按已识别下限显示';
        coverageNote.textContent = `${requestCoverageLabel}；${failoverCoverageLabel}。更新于 ${sub2FormatRelative(reliabilitySnapshot.generatedAt, now)}。`;
        reliabilityCard.append(reliabilityGrid, coverageNote);
      }
      if (this.reliabilityError && reliabilitySnapshot) {
        const staleDataNote = document.createElement('div');
        staleDataNote.className = 'sub2-diagnostics-note';
        staleDataNote.textContent = `${this.reliabilityError}；当前继续显示上次成功读取的统计。`;
        reliabilityCard.appendChild(staleDataNote);
      }
      this.eventsBodyElement.appendChild(reliabilityCard);

      const eventsCard = document.createElement('section');
      eventsCard.className = 'sub2-events-card';
      const eventsTitle = document.createElement('h3');
      eventsTitle.textContent = `本地事件 · ${this.localEvents.length}`;
      eventsCard.appendChild(eventsTitle);

      const toolbar = document.createElement('div');
      toolbar.className = 'sub2-events-toolbar';
      const eventTypeSelect = document.createElement('select');
      eventTypeSelect.title = '按事件类型筛选';
      const eventTypeOptions = [
        { value: '', label: '全部事件' },
        { value: 'status-429', label: '429 限流' },
        { value: 'status-403', label: '403 鉴权' },
        { value: 'status-5xx', label: '5xx 上游' },
        { value: 'cooldown', label: '冷却变化' },
        { value: 'hit-change', label: '命中变化' },
      ];
      for (const optionDefinition of eventTypeOptions) {
        const optionElement = document.createElement('option');
        optionElement.value = optionDefinition.value;
        optionElement.textContent = optionDefinition.label;
        eventTypeSelect.appendChild(optionElement);
      }
      eventTypeSelect.value = this.eventTypeFilter;
      eventTypeSelect.addEventListener('change', () => {
        this.eventTypeFilter = eventTypeSelect.value;
        this.renderEventsDrawer();
      });

      const retentionSelect = document.createElement('select');
      retentionSelect.title = '本地事件保留时间';
      for (const retentionDays of SUB2_EVENT_RETENTION_OPTIONS) {
        const optionElement = document.createElement('option');
        optionElement.value = String(retentionDays);
        optionElement.textContent = retentionDays === 1 ? '保留 24 小时' : `保留 ${retentionDays} 天`;
        retentionSelect.appendChild(optionElement);
      }
      retentionSelect.value = String(this.eventRetentionDays);
      retentionSelect.addEventListener('change', () => this.setEventRetentionDays(retentionSelect.value));

      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'sub2-events-clear';
      clearButton.textContent = '清空';
      clearButton.disabled = this.localEvents.length === 0;
      clearButton.addEventListener('click', () => this.clearLocalEvents());
      toolbar.append(eventTypeSelect, retentionSelect, clearButton);
      eventsCard.appendChild(toolbar);

      const policyNote = document.createElement('div');
      policyNote.className = 'sub2-events-policy';
      policyNote.textContent = `事件只保存在当前浏览器，按保留天数自动清理，并限制最多 ${SUB2_LOCAL_EVENT_LIMIT} 条；切换保留期会立即清理过期事件。`;
      eventsCard.appendChild(policyNote);

      const matchingEvents = this.localEvents.filter(
        (localEvent) => !this.eventTypeFilter || localEvent.type === this.eventTypeFilter,
      );
      const eventList = document.createElement('div');
      eventList.className = 'sub2-event-list';
      for (const localEvent of matchingEvents.slice(0, 150)) {
        const eventItem = document.createElement('div');
        eventItem.className = `sub2-event-item ${localEvent.tone}`;
        const eventHead = document.createElement('div');
        eventHead.className = 'sub2-event-head';
        const eventTitle = document.createElement('span');
        eventTitle.className = 'sub2-event-title';
        const accountLabel = localEvent.accountId
          ? this.getAccountDisplayName(localEvent.accountId, localEvent.accountName)
          : '';
        eventTitle.textContent = `${localEvent.title || '可靠性事件'}${accountLabel ? ` · ${accountLabel}` : ''}`;
        const eventTime = document.createElement('span');
        eventTime.className = 'sub2-event-time';
        eventTime.textContent = sub2FormatRelative(localEvent.occurredAt, now);
        eventHead.append(eventTitle, eventTime);
        const eventDetail = document.createElement('div');
        eventDetail.className = 'sub2-event-detail';
        eventDetail.textContent = localEvent.detail || '没有附加详情。';
        const eventMetadata = document.createElement('div');
        eventMetadata.className = 'sub2-event-meta';
        eventMetadata.textContent = [
          localEvent.statusCode ? `状态 ${localEvent.statusCode}` : '',
          localEvent.model ? `模型 ${localEvent.model}` : '',
          localEvent.requestId ? `请求 ${localEvent.requestId}` : '',
          `来源 ${localEvent.source}`,
        ].filter(Boolean).join(' · ');
        eventItem.append(eventHead, eventDetail, eventMetadata);
        eventList.appendChild(eventItem);
      }
      if (!matchingEvents.length) {
        const emptyNote = document.createElement('div');
        emptyNote.className = 'sub2-diagnostics-note';
        emptyNote.textContent = this.localEvents.length
          ? '没有符合当前筛选条件的事件。'
          : '暂无本地事件。刷新会记录真实错误和账号状态变化；打开事件中心会回填近 24 小时可读取的错误。';
        eventList.appendChild(emptyNote);
      } else if (matchingEvents.length > 150) {
        const overflowNote = document.createElement('div');
        overflowNote.className = 'sub2-diagnostics-note';
        overflowNote.textContent = `当前只渲染最新 150 条，另有 ${matchingEvents.length - 150} 条仍按本地策略保留。`;
        eventList.appendChild(overflowNote);
      }
      eventsCard.appendChild(eventList);
      this.eventsBodyElement.appendChild(eventsCard);
      this.eventsBodyElement.scrollTop = savedScrollTop;
    }

    renderAuditDrawer() {
      if (!this.auditOpen || !this.auditOverlayElement || !this.auditBodyElement) return;
      this.auditOverlayElement.hidden = false;
      const savedScrollTop = this.auditBodyElement.scrollTop;
      const now = Date.now();
      this.auditBodyElement.textContent = '';

      const auditFindings = [];

      const schedulableAccounts = this.accounts.filter((account) => account.schedulable !== false);
      const accountsByGroupId = new Map();
      for (const account of schedulableAccounts) {
        const groupIds = Array.isArray(account.groups) ? account.groups : [];
        for (const groupId of groupIds) {
          if (!accountsByGroupId.has(groupId)) accountsByGroupId.set(groupId, []);
          accountsByGroupId.get(groupId).push(account);
        }
      }

      for (const [groupId, groupAccounts] of accountsByGroupId) {
        if (groupAccounts.length === 1) {
          const group = sub2GetIndexedGroup(this.groupsById, groupId);
          auditFindings.push({
            severity: 'critical',
            category: 'single-point',
            message: `分组"${group?.name || groupId}"只有 1 个可调度账号`,
            detail: `分组"${group?.name || groupId}"仅包含账号 ${this.getAccountDisplayName(groupAccounts[0].id)}。如果该账号受限或失败，分组将完全不可用。`,
            accountId: groupAccounts[0].id,
          });
        }
      }

      const accountsByPlatform = new Map();
      for (const account of schedulableAccounts) {
        const platform = account.platform || 'unknown';
        if (!accountsByPlatform.has(platform)) accountsByPlatform.set(platform, []);
        accountsByPlatform.get(platform).push(account);
      }

      for (const account of this.accounts) {
        const health = sub2ComputeHealth(account, now);
        if (health.tone === 'down' && account.schedulable !== false) {
          auditFindings.push({
            severity: 'warning',
            category: 'account-down',
            message: `账号 ${this.getAccountDisplayName(account.id)} 当前不可用`,
            detail: health.reason || '账号当前处于不可用状态，已从调度池排除。',
            accountId: account.id,
          });
        }

        const configuredCapacity = sub2GetNumericAccountField(account, 'concurrency_capacity');
        if (configuredCapacity > 0) {
          const currentOccupied = account.concurrency_occupied || 0;
          const currentQueued = account.concurrency_queued || 0;
          const reliabilityStats = this.reliabilitySnapshot?.accountStats?.[account.id];
          const status429Count = reliabilityStats?.status429 || 0;
          const totalRequests = reliabilityStats?.requests || 0;
          const rateLimitRatio = totalRequests > 0 ? status429Count / totalRequests : 0;

          if (rateLimitRatio > SUB2_CAPACITY_RATE_LIMIT_RATIO) {
            auditFindings.push({
              severity: 'warning',
              category: 'capacity-high',
              message: `账号 ${this.getAccountDisplayName(account.id)} 近 24 小时 429 占比 ${(rateLimitRatio * 100).toFixed(1)}%`,
              detail: `当前容量配置 ${configuredCapacity}，近 24 小时触发 ${status429Count} 次 429，占 ${totalRequests} 次请求的 ${(rateLimitRatio * 100).toFixed(1)}%。建议降低容量至 ${Math.max(1, Math.floor(configuredCapacity * 0.7))} 左右。`,
              accountId: account.id,
              suggestedCapacity: Math.max(1, Math.floor(configuredCapacity * 0.7)),
            });
          } else if (currentOccupied >= configuredCapacity * SUB2_CAPACITY_HIGH_LOAD_RATIO && currentQueued > 0) {
            auditFindings.push({
              severity: 'info',
              category: 'capacity-low',
              message: `账号 ${this.getAccountDisplayName(account.id)} 当前高负载 ${currentOccupied}/${configuredCapacity}`,
              detail: `当前占用 ${currentOccupied}，排队 ${currentQueued}，达到容量配置 ${configuredCapacity} 的 ${((currentOccupied / configuredCapacity) * 100).toFixed(0)}%。如果未触发 429，可考虑提升容量至 ${configuredCapacity + Math.ceil(configuredCapacity * 0.3)}。`,
              accountId: account.id,
              suggestedCapacity: configuredCapacity + Math.ceil(configuredCapacity * 0.3),
            });
          }
        }

        if (account.platform === 'openai-oauth' && account.models && Array.isArray(account.models)) {
          const foreignModels = account.models.filter((modelName) =>
            SUB2_OPENAI_OAUTH_FOREIGN_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix)),
          );
          if (foreignModels.length > 0) {
            auditFindings.push({
              severity: 'warning',
              category: 'platform-config',
              message: `账号 ${this.getAccountDisplayName(account.id)} 包含非 OpenAI 模型`,
              detail: `平台 openai-oauth 下检测到 ${foreignModels.length} 个非 OpenAI 模型（${foreignModels.slice(0, 3).join(', ')}${foreignModels.length > 3 ? '...' : ''}），可能导致路由异常。`,
              accountId: account.id,
            });
          }
        }
      }

      auditFindings.sort((left, right) => {
        const severityDiff = SUB2_AUDIT_SEVERITY_RANK[right.severity] - SUB2_AUDIT_SEVERITY_RANK[left.severity];
        if (severityDiff !== 0) return severityDiff;
        return (left.message || '').localeCompare(right.message || '');
      });

      const summaryCard = document.createElement('section');
      summaryCard.className = 'sub2-audit-card';
      const summaryTitle = document.createElement('h3');
      summaryTitle.textContent = '审计摘要';
      const summaryDetail = document.createElement('div');
      summaryDetail.className = 'sub2-diagnostics-note';
      const criticalCount = auditFindings.filter((finding) => finding.severity === 'critical').length;
      const warningCount = auditFindings.filter((finding) => finding.severity === 'warning').length;
      const infoCount = auditFindings.filter((finding) => finding.severity === 'info').length;
      summaryDetail.textContent = auditFindings.length
        ? `共发现 ${auditFindings.length} 项：${criticalCount} 严重、${warningCount} 注意、${infoCount} 提示。`
        : '当前配置未发现明显风险。持续关注单点故障、平台配置异常和容量建议。';
      summaryCard.append(summaryTitle, summaryDetail);
      this.auditBodyElement.appendChild(summaryCard);

      if (auditFindings.length > 0) {
        const findingsCard = document.createElement('section');
        findingsCard.className = 'sub2-audit-card';
        const findingsTitle = document.createElement('h3');
        findingsTitle.textContent = '发现项';
        findingsCard.appendChild(findingsTitle);

        for (const finding of auditFindings) {
          const findingItem = document.createElement('div');
          findingItem.className = `sub2-audit-item ${finding.severity}`;
          const findingHead = document.createElement('div');
          findingHead.className = 'sub2-audit-item-head';
          const severityBadge = document.createElement('span');
          severityBadge.className = `sub2-audit-severity ${finding.severity}`;
          severityBadge.textContent = SUB2_AUDIT_SEVERITY_LABELS[finding.severity] || finding.severity;
          const findingMessage = document.createElement('span');
          findingMessage.className = 'sub2-audit-message';
          findingMessage.textContent = finding.message;
          findingHead.append(severityBadge, findingMessage);
          const findingDetail = document.createElement('div');
          findingDetail.className = 'sub2-audit-detail';
          findingDetail.textContent = finding.detail;
          findingItem.append(findingHead, findingDetail);

          if (finding.suggestedCapacity && finding.accountId) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = 'sub2-audit-action';
            actionButton.textContent = `调整容量至 ${finding.suggestedCapacity}`;
            actionButton.addEventListener('click', () => {
              const targetAccount = this.accounts.find((account) => account.id === finding.accountId);
              if (targetAccount) {
                this.openCapacityEditor(targetAccount, finding.suggestedCapacity);
                this.closeAuditDrawer();
              }
            });
            findingItem.appendChild(actionButton);
          }

          findingsCard.appendChild(findingItem);
        }

        this.auditBodyElement.appendChild(findingsCard);
      }

      this.auditBodyElement.scrollTop = savedScrollTop;
    }

    getDiagnosticsRequest() {
      if (!this.selectedDiagnosticsRequestKey) return this.recentRequest || this.requestHistory[0] || null;
      return this.requestHistory.find(
        (requestItem) => sub2GetRequestHistoryKey(requestItem) === this.selectedDiagnosticsRequestKey,
      ) || this.recentRequest;
    }

    getDiagnosticsRouteState(diagnosticsRequest) {
      const isLatestSuccessRequest = diagnosticsRequest
        && this.recentRequest
        && sub2GetRequestHistoryKey(diagnosticsRequest) === sub2GetRequestHistoryKey(this.recentRequest);
      if (isLatestSuccessRequest) {
        return {
          errorsAvailable: this.routingErrorsAvailable,
          errorsComplete: this.routingErrorsComplete,
          routeChain: this.routeChain,
          routeDetailsAvailable: this.routeDetailsAvailable,
        };
      }
      if (!this.selectedDiagnosticsRequestKey) {
        return {
          errorsAvailable: false,
          errorsComplete: false,
          routeChain: sub2BuildRouteChain(diagnosticsRequest, [], [], false),
          routeDetailsAvailable: false,
        };
      }
      if (this.selectedRouteReplay?.requestKey === sub2GetRequestHistoryKey(diagnosticsRequest)) {
        return this.selectedRouteReplay;
      }
      return {
        errorsAvailable: false,
        errorsComplete: false,
        routeChain: sub2BuildRouteChain(diagnosticsRequest, [], [], false),
        routeDetailsAvailable: false,
      };
    }

    createHistoryFilter(options, value, title, onChange) {
      const selectElement = document.createElement('select');
      selectElement.title = title;
      for (const optionDefinition of options) {
        const optionElement = document.createElement('option');
        optionElement.value = optionDefinition.value;
        optionElement.textContent = optionDefinition.label;
        selectElement.appendChild(optionElement);
      }
      selectElement.value = options.some((optionDefinition) => optionDefinition.value === value) ? value : '';
      selectElement.addEventListener('change', () => onChange(selectElement.value));
      return selectElement;
    }

    renderRequestHistoryCard(now) {
      const historyCard = document.createElement('section');
      historyCard.className = 'sub2-diagnostics-card';
      const historyTitle = document.createElement('h3');
      historyTitle.textContent = `真实请求历史（最近 ${this.requestHistory.length} 条 / 30 分钟）`;
      historyCard.appendChild(historyTitle);

      if (!this.requestHistory.length) {
        const historyEmpty = document.createElement('div');
        historyEmpty.className = 'sub2-diagnostics-note';
        historyEmpty.textContent = this.routingRequestsAvailable
          ? '最近 30 分钟没有可展示的真实请求。'
          : 'sub2 运维请求接口当前不可用。';
        historyCard.appendChild(historyEmpty);
        return historyCard;
      }

      const modelValues = [...new Set(this.requestHistory.map((requestItem) => requestItem.model).filter(Boolean))]
        .sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
      const groupValues = [...new Set(this.requestHistory.map((requestItem) => requestItem.groupId).filter(Boolean))]
        .sort((leftValue, rightValue) => leftValue - rightValue);
      const accountValues = [...new Set(this.requestHistory.map((requestItem) => requestItem.accountId).filter(Boolean))]
        .sort((leftValue, rightValue) => this.getAccountDisplayName(leftValue).localeCompare(this.getAccountDisplayName(rightValue)));
      const filtersElement = document.createElement('div');
      filtersElement.className = 'sub2-history-filters';
      filtersElement.append(
        this.createHistoryFilter(
          [{ value: '', label: '全部模型' }].concat(modelValues.map((model) => ({ value: model, label: model }))),
          this.historyModelFilter,
          '按模型筛选请求历史',
          (value) => { this.historyModelFilter = value; this.renderDiagnosticsDrawer(); },
        ),
        this.createHistoryFilter(
          [{ value: '', label: '全部分组' }].concat(groupValues.map((groupId) => ({
            value: String(groupId),
            label: String(sub2GetIndexedGroup(this.groupsById, groupId)?.name || `分组 ${groupId}`),
          }))),
          this.historyGroupFilter,
          '按分组筛选请求历史',
          (value) => { this.historyGroupFilter = value; this.renderDiagnosticsDrawer(); },
        ),
        this.createHistoryFilter(
          [{ value: '', label: '全部账号' }].concat(accountValues.map((accountId) => ({
            value: String(accountId),
            label: this.getAccountDisplayName(accountId),
          }))),
          this.historyAccountFilter,
          '按最终账号筛选请求历史',
          (value) => { this.historyAccountFilter = value; this.renderDiagnosticsDrawer(); },
        ),
        this.createHistoryFilter([
          { value: '', label: '全部结果' },
          { value: 'direct', label: '直接成功' },
          { value: 'failover', label: '故障转移成功' },
          { value: 'error', label: '最终失败' },
          { value: 'unknown', label: '链路未知' },
        ], this.historyRouteFilter, '按路由结果筛选请求历史', (value) => {
          this.historyRouteFilter = value;
          this.renderDiagnosticsDrawer();
        }),
      );
      historyCard.appendChild(filtersElement);

      const matchingRequests = this.requestHistory.filter((requestItem) => {
        if (this.historyModelFilter && requestItem.model !== this.historyModelFilter) return false;
        if (this.historyGroupFilter && String(requestItem.groupId || '') !== this.historyGroupFilter) return false;
        if (this.historyAccountFilter && String(requestItem.accountId || '') !== this.historyAccountFilter) return false;
        if (this.historyRouteFilter && requestItem.routeStatus !== this.historyRouteFilter) return false;
        return true;
      });
      const historyList = document.createElement('div');
      historyList.className = 'sub2-history-list';
      const selectedRequest = this.getDiagnosticsRequest();
      const selectedRequestKey = selectedRequest ? sub2GetRequestHistoryKey(selectedRequest) : '';
      const routeStatusLabels = {
        direct: '直接成功',
        failover: '故障转移',
        error: '最终失败',
        unknown: '链路未知',
      };
      for (const requestItem of matchingRequests) {
        const requestKey = sub2GetRequestHistoryKey(requestItem);
        const requestButton = document.createElement('button');
        requestButton.type = 'button';
        requestButton.className = `sub2-history-item${requestKey === selectedRequestKey ? ' selected' : ''}`;
        requestButton.addEventListener('click', () => this.handleSelectDiagnosticsRequest(requestItem));
        const requestMain = document.createElement('span');
        requestMain.className = 'sub2-history-main';
        const requestTitle = document.createElement('span');
        requestTitle.className = 'sub2-history-title';
        requestTitle.textContent = [
          requestItem.model || '模型未知',
          requestItem.accountId ? this.getAccountDisplayName(requestItem.accountId) : '账号未知',
        ].join(' · ');
        const requestMetadata = document.createElement('span');
        requestMetadata.className = 'sub2-history-meta';
        const group = requestItem.groupId ? sub2GetIndexedGroup(this.groupsById, requestItem.groupId) : null;
        requestMetadata.textContent = [
          sub2FormatRelative(requestItem.createdAt, now),
          sub2FormatDuration(requestItem.durationMs),
          group ? String(group.name || requestItem.groupId) : requestItem.groupId ? `分组 ${requestItem.groupId}` : '',
        ].filter(Boolean).join(' · ');
        requestMain.append(requestTitle, requestMetadata);
        const requestBadges = document.createElement('span');
        requestBadges.className = 'sub2-history-badges';
        const outcomeBadge = document.createElement('span');
        outcomeBadge.className = `sub2-history-badge ${requestItem.kind}`;
        outcomeBadge.textContent = requestItem.kind === 'success' ? '成功' : `${requestItem.statusCode || ''} 失败`.trim();
        const routeBadge = document.createElement('span');
        routeBadge.className = `sub2-history-badge ${requestItem.routeStatus}`;
        routeBadge.textContent = routeStatusLabels[requestItem.routeStatus] || '链路未知';
        requestBadges.append(outcomeBadge, routeBadge);
        requestButton.append(requestMain, requestBadges);
        historyList.appendChild(requestButton);
      }
      if (!matchingRequests.length) {
        const filteredEmpty = document.createElement('div');
        filteredEmpty.className = 'sub2-diagnostics-note';
        filteredEmpty.textContent = '没有符合当前筛选条件的请求。';
        historyList.appendChild(filteredEmpty);
      }
      historyCard.appendChild(historyList);
      return historyCard;
    }

    async handleSelectDiagnosticsRequest(requestItem) {
      const requestKey = sub2GetRequestHistoryKey(requestItem);
      this.selectedDiagnosticsRequestKey = requestKey;
      this.routeReplayError = '';
      const latestRequestKey = this.recentRequest ? sub2GetRequestHistoryKey(this.recentRequest) : '';
      if (requestKey === latestRequestKey) {
        this.selectedRouteReplay = null;
        this.routeReplayLoading = false;
        this.renderDiagnosticsDrawer();
        return;
      }

      const cachedReplay = this.routeReplayCache.get(requestKey);
      if (cachedReplay) {
        this.selectedRouteReplay = cachedReplay;
        this.routeReplayLoading = false;
        this.renderDiagnosticsDrawer();
        return;
      }

      const requestSequence = ++this.routeReplayRequestSequence;
      this.routeReplayLoading = true;
      this.selectedRouteReplay = null;
      this.renderDiagnosticsDrawer();
      try {
        const replay = await sub2FetchRouteReplay(requestItem);
        if (requestSequence !== this.routeReplayRequestSequence || this.selectedDiagnosticsRequestKey !== requestKey) return;
        const cachedValue = { ...replay, requestKey };
        this.routeReplayCache.set(requestKey, cachedValue);
        this.selectedRouteReplay = cachedValue;
        if (requestItem.kind === 'success') {
          const hasFailureEvent = Array.isArray(replay.routeChain?.events)
            && replay.routeChain.events.some((routeEvent) => routeEvent.type === 'failure');
          this.requestHistory = this.requestHistory.map((historyItem) => sub2GetRequestHistoryKey(historyItem) === requestKey
            ? {
              ...historyItem,
              routeStatus: hasFailureEvent ? 'failover' : replay.errorsComplete ? 'direct' : 'unknown',
            }
            : historyItem);
        }
      } catch (error) {
        if (requestSequence !== this.routeReplayRequestSequence || this.selectedDiagnosticsRequestKey !== requestKey) return;
        this.routeReplayError = `请求回放读取失败：${error?.message || error}`;
      } finally {
        if (requestSequence === this.routeReplayRequestSequence && this.selectedDiagnosticsRequestKey === requestKey) {
          this.routeReplayLoading = false;
          this.renderDiagnosticsDrawer();
        }
      }
    }

    openDiagnosticsDrawer() {
      this.closeEventsDrawer();
      this.routeReplayRequestSequence += 1;
      this.selectedDiagnosticsRequestKey = '';
      this.selectedRouteReplay = null;
      this.routeReplayLoading = false;
      this.routeReplayError = '';
      this.diagnosticsOpen = true;
      if (this.diagnosticsOverlayElement) this.diagnosticsOverlayElement.hidden = false;
      if (this.diagnosticsBodyElement) this.diagnosticsBodyElement.scrollTop = 0;
      this.renderDiagnosticsDrawer();
    }

    closeDiagnosticsDrawer() {
      this.diagnosticsOpen = false;
      if (this.diagnosticsOverlayElement) this.diagnosticsOverlayElement.hidden = true;
    }

    getAccountDisplayName(accountId, fallbackName = '') {
      const account = this.accounts.find((candidateAccount) => Number(candidateAccount?.id) === Number(accountId));
      return String(account?.name || fallbackName || `账号 ${accountId}`).trim() || `账号 ${accountId}`;
    }

    renderDiagnosticsDrawer() {
      if (!this.diagnosticsOpen || !this.diagnosticsOverlayElement || !this.diagnosticsBodyElement) return;
      this.diagnosticsOverlayElement.hidden = false;
      const savedScrollTop = this.diagnosticsBodyElement.scrollTop;
      const now = Date.now();
      this.diagnosticsBodyElement.textContent = '';
      this.diagnosticsBodyElement.appendChild(this.renderRequestHistoryCard(now));
      const diagnosticsRequest = this.getDiagnosticsRequest();

      if (!diagnosticsRequest) {
        const emptyCard = document.createElement('section');
        emptyCard.className = 'sub2-diagnostics-card';
        const emptyTitle = document.createElement('h3');
        emptyTitle.textContent = '暂无可分析请求';
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'sub2-diagnostics-note';
        emptyMessage.textContent = this.routingRequestsAvailable
          ? '最近 30 分钟没有真实请求。脚本不会为了生成诊断而主动发送模型请求。'
          : 'sub2 运维请求接口当前不可用，无法建立请求级诊断。账号健康与容量仍按可用接口显示。';
        emptyCard.append(emptyTitle, emptyMessage);
        this.diagnosticsBodyElement.appendChild(emptyCard);
        return;
      }

      const requestCard = document.createElement('section');
      requestCard.className = 'sub2-diagnostics-card';
      const requestTitle = document.createElement('h3');
      requestTitle.textContent = diagnosticsRequest.kind === 'success' ? '请求回放 · 成功' : '请求回放 · 失败';
      const requestFacts = document.createElement('div');
      requestFacts.className = 'sub2-request-facts';
      const requestGroup = diagnosticsRequest.groupId
        ? sub2GetIndexedGroup(this.groupsById, diagnosticsRequest.groupId)
        : null;
      const factValues = [
        diagnosticsRequest.accountId
          ? `${diagnosticsRequest.kind === 'success' ? '命中' : '最终账号'} ${this.getAccountDisplayName(diagnosticsRequest.accountId)}`
          : '最终账号 未记录',
        diagnosticsRequest.model ? `模型 ${diagnosticsRequest.model}` : '',
        diagnosticsRequest.platform ? `平台 ${diagnosticsRequest.platform}` : '',
        diagnosticsRequest.groupId
          ? `分组 ${String(requestGroup?.name || diagnosticsRequest.groupId).trim()}`
          : '',
        `时间 ${sub2FormatRelative(diagnosticsRequest.createdAt, now)}`,
        sub2FormatDuration(diagnosticsRequest.durationMs),
        diagnosticsRequest.statusCode ? `状态 ${diagnosticsRequest.statusCode}` : '',
      ].filter(Boolean);
      for (const factValue of factValues) {
        const fact = document.createElement('span');
        fact.textContent = factValue;
        requestFacts.appendChild(fact);
      }
      if (diagnosticsRequest.requestId) {
        const requestId = document.createElement('span');
        requestId.textContent = `请求 ${diagnosticsRequest.requestId.length > 22
          ? `${diagnosticsRequest.requestId.slice(0, 19)}...`
          : diagnosticsRequest.requestId}`;
        requestId.title = diagnosticsRequest.requestId;
        requestFacts.appendChild(requestId);
      }
      requestCard.append(requestTitle, requestFacts);
      this.diagnosticsBodyElement.appendChild(requestCard);

      const diagnosticsRouteState = this.getDiagnosticsRouteState(diagnosticsRequest);
      const diagnosticsRouteChain = diagnosticsRouteState.routeChain || { events: [], detailLevel: 'success-only' };
      const routeCard = document.createElement('section');
      routeCard.className = 'sub2-diagnostics-card';
      const routeTitle = document.createElement('h3');
      routeTitle.textContent = '故障转移链';
      const routeNote = document.createElement('div');
      routeNote.className = 'sub2-diagnostics-note';
      if (this.routeReplayLoading) {
        routeNote.textContent = '正在按请求 ID 读取关联错误和详情；只在你点击历史记录时执行，不发送模型请求。';
      } else if (this.routeReplayError) {
        routeNote.textContent = this.routeReplayError;
      } else if (!diagnosticsRouteState.errorsAvailable) {
        routeNote.textContent = '上游错误接口本次不可用，无法判断该请求之前是否发生过失败或降级。';
      } else if (!diagnosticsRouteState.errorsComplete && diagnosticsRouteChain.detailLevel === 'success-only') {
        routeNote.textContent = '上游错误摘要超过本次读取上限，当前未匹配到该请求，不能据此断言它是直接成功。可点击该历史记录按请求 ID 精确回放。';
      } else if (diagnosticsRouteChain.detailLevel === 'detailed') {
        routeNote.textContent = diagnosticsRequest.kind === 'success'
          ? '详情链：来自该请求关联错误详情中的 upstream_errors，并追加最终成功账号。'
          : '详情链：来自该失败请求关联错误详情中的 upstream_errors，并追加最终失败节点。';
      } else if (diagnosticsRouteChain.detailLevel === 'partial') {
        routeNote.textContent = '部分详情链：已合并成功读取的详情事件和其余关联摘要，可能仍缺少中间尝试，不能视为完整轨迹。';
      } else if (diagnosticsRouteChain.detailLevel === 'summary') {
        routeNote.textContent = '摘要链：当前只拿到关联错误列表摘要，可能缺少中间尝试账号，不能视为完整轨迹。';
      } else if (diagnosticsRouteChain.detailLevel === 'request-error') {
        routeNote.textContent = '只确认请求最终失败，未读取到关联的上游尝试详情。';
      } else {
        routeNote.textContent = '未发现与该成功请求关联的上游失败，当前链路只包含最终成功账号。';
      }
      if (
        diagnosticsRouteState.errorsAvailable
        && !diagnosticsRouteState.routeDetailsAvailable
        && (diagnosticsRouteChain.detailLevel === 'summary' || diagnosticsRouteChain.detailLevel === 'partial')
      ) {
        routeNote.textContent += ' 部分错误详情本次读取失败或超过读取上限。';
      }
      if (diagnosticsRouteChain.unresolvedRecoveredSummaryCount > 0) {
        routeNote.textContent += ' 已确认发生过恢复型故障，但摘要行只记录最终请求账号；失败账号需以详情事件为准。';
      }
      const routeChainElement = document.createElement('div');
      routeChainElement.className = 'sub2-route-chain';
      const routeEvents = Array.isArray(diagnosticsRouteChain?.events) ? diagnosticsRouteChain.events : [];
      for (const routeEvent of routeEvents) {
        const routeEventElement = document.createElement('div');
        routeEventElement.className = `sub2-route-event${routeEvent.type === 'success' ? ' success' : ''}`;
        const eventHead = document.createElement('div');
        eventHead.className = 'sub2-route-event-head';
        const eventAccount = document.createElement('span');
        eventAccount.textContent = `${routeEvent.type === 'success' ? '成功' : '失败'} · ${this.getAccountDisplayName(routeEvent.accountId, routeEvent.accountName)}`;
        const eventTime = document.createElement('span');
        eventTime.className = 'sub2-route-event-time';
        eventTime.textContent = routeEvent.occurredAt
          ? sub2FormatRelative(routeEvent.occurredAt, now)
          : '时间未知';
        eventHead.append(eventAccount, eventTime);
        const eventReason = document.createElement('div');
        eventReason.className = 'sub2-route-event-reason';
        eventReason.textContent = sub2DescribeRouteEvent(routeEvent);
        routeEventElement.append(eventHead, eventReason);
        routeChainElement.appendChild(routeEventElement);
      }
      routeCard.append(routeTitle, routeNote, routeChainElement);
      this.diagnosticsBodyElement.appendChild(routeCard);

      const candidatesCard = document.createElement('section');
      candidatesCard.className = 'sub2-diagnostics-card';
      const candidatesTitle = document.createElement('h3');
      candidatesTitle.textContent = '更高优先级账号资格';
      const candidatesList = document.createElement('div');
      candidatesList.className = 'sub2-candidate-list';
      const requestSucceeded = diagnosticsRequest.kind === 'success' && Boolean(diagnosticsRequest.accountId);
      const hitAccount = requestSucceeded
        ? this.accounts.find((account) => Number(account?.id) === Number(diagnosticsRequest.accountId))
        : null;
      const hitEffectivePriority = hitAccount
        ? sub2GetEffectivePriority(hitAccount, diagnosticsRequest.groupId, this.groupsById)
        : null;
      const candidateAccounts = hitAccount
        ? this.accounts
          .filter((account) => Number(account?.id) !== Number(diagnosticsRequest.accountId))
          .map((account) => ({
            account,
            effectivePriority: sub2GetEffectivePriority(account, diagnosticsRequest.groupId, this.groupsById),
          }))
          .filter((candidate) => candidate.effectivePriority < hitEffectivePriority)
          .sort((leftCandidate, rightCandidate) => leftCandidate.effectivePriority - rightCandidate.effectivePriority
            || String(leftCandidate.account?.name || '').localeCompare(String(rightCandidate.account?.name || '')))
        : [];

      const statusLabels = {
        attempted: '已尝试失败',
        excluded: '当前排除',
        constrained: '当前受限',
        eligible: '当前可候选',
        unknown: '仍需判断',
      };
      if (!requestSucceeded) {
        const failedRequestNote = document.createElement('div');
        failedRequestNote.className = 'sub2-diagnostics-note';
        failedRequestNote.textContent = '该记录最终失败，没有最终成功账号，因此不进行更高优先级候选比较。';
        candidatesList.appendChild(failedRequestNote);
      } else if (!hitAccount) {
        const unavailableComparison = document.createElement('div');
        unavailableComparison.className = 'sub2-diagnostics-note';
        unavailableComparison.textContent = '最终成功账号不在当前账号列表中，仍可查看请求和故障转移链，但无法比较请求内有效优先级。';
        candidatesList.appendChild(unavailableComparison);
      } else if (!candidateAccounts.length) {
        const noCandidates = document.createElement('div');
        noCandidates.className = 'sub2-diagnostics-note';
        noCandidates.textContent = `最终命中账号的请求内有效优先级为 ${hitEffectivePriority}，没有更高优先级账号可比较。`;
        candidatesList.appendChild(noCandidates);
      }

      for (const candidate of candidateAccounts) {
        const accountId = Number(candidate.account.id);
        const savedModelState = this.savedModelsByAccountId.get(accountId) || null;
        const eligibility = sub2EvaluateCandidateEligibility(candidate.account, {
          recentRequest: diagnosticsRequest,
          groupsById: this.groupsById,
          routeChain: diagnosticsRouteChain,
          concurrency: sub2ResolveAccountConcurrency(
            accountId,
            diagnosticsRequest.groupId,
            this.concurrencyByAccountId,
            this.concurrencyRecordsByAccountId,
          ),
          concurrencyAvailable: this.concurrencyAvailable,
          concurrencyEnabled: this.concurrencyEnabled,
          savedModelState,
        }, now);
        const candidateElement = document.createElement('div');
        candidateElement.className = 'sub2-candidate';
        const candidateHead = document.createElement('div');
        candidateHead.className = 'sub2-candidate-head';
        const candidateName = document.createElement('span');
        candidateName.className = 'sub2-candidate-name';
        candidateName.textContent = this.getAccountDisplayName(accountId);
        candidateName.title = candidateName.textContent;
        const candidatePriority = document.createElement('span');
        candidatePriority.className = 'sub2-candidate-priority';
        candidatePriority.textContent = `有效 P${eligibility.effectivePriority}`;
        const candidateBadge = document.createElement('span');
        candidateBadge.className = `sub2-candidate-badge ${eligibility.tone}`;
        candidateBadge.textContent = statusLabels[eligibility.status] || '信息不足';
        candidateBadge.title = eligibility.evidence;
        candidateHead.append(candidateName, candidatePriority, candidateBadge);
        const candidateReasons = document.createElement('div');
        candidateReasons.className = 'sub2-candidate-reasons';
        candidateReasons.textContent = `${eligibility.evidence}：${eligibility.reasons.join('；')}`;
        candidateElement.append(candidateHead, candidateReasons);

        if (eligibility.modelCheckNeeded && diagnosticsRequest.model) {
          const modelButton = document.createElement('button');
          modelButton.type = 'button';
          modelButton.className = 'sub2-candidate-model-button';
          modelButton.disabled = savedModelState?.status === 'loading';
          modelButton.textContent = savedModelState?.status === 'loading'
            ? '正在读取保存模型…'
            : savedModelState?.status === 'error'
              ? '重试读取保存模型'
              : '核对保存模型';
          modelButton.title = '只读取 sub2 已保存模型，不访问上游';
          modelButton.addEventListener('click', () => this.handleLoadCandidateModels(accountId));
          candidateElement.appendChild(modelButton);
        }
        candidatesList.appendChild(candidateElement);
      }
      candidatesCard.append(candidatesTitle, candidatesList);
      this.diagnosticsBodyElement.appendChild(candidatesCard);

      const boundaryNote = document.createElement('div');
      boundaryNote.className = 'sub2-diagnostics-note';
      boundaryNote.textContent = '证据边界：故障事件和最终命中可作为历史证据；健康、配额、容量及分组状态是当前快照。sub2 未持久化完整候选评分时，只能对未尝试账号做资格判断，不能断言调度器当时一定看过它。';
      this.diagnosticsBodyElement.appendChild(boundaryNote);
      this.diagnosticsBodyElement.scrollTop = savedScrollTop;
    }

    async handleLoadCandidateModels(accountId) {
      const numericAccountId = Number(accountId);
      if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) return;
      this.savedModelsByAccountId.set(numericAccountId, { status: 'loading', models: [] });
      this.renderDiagnosticsDrawer();
      if (!this.isAccountInteractionActive()) this.renderList();
      try {
        const models = await sub2FetchAccountModels(numericAccountId);
        this.savedModelsByAccountId.set(numericAccountId, { status: 'loaded', models });
      } catch (error) {
        this.savedModelsByAccountId.set(numericAccountId, {
          status: 'error',
          models: [],
          error: String(error?.message || error),
        });
      }
      this.renderDiagnosticsDrawer();
      if (!this.isAccountInteractionActive()) this.renderList();
    }

    async openModelDrawer(account) {
      this.closeEventsDrawer();
      this.closeDiagnosticsDrawer();
      const requestSequence = ++this.modelRequestSequence;
      this.modelAccount = account;
      this.models = [];
      this.modelFilterText = '';
      this.modelLoading = true;
      this.modelSyncing = false;
      this.modelMessage = '';
      this.modelError = '';
      if (this.modelSearchElement) this.modelSearchElement.value = '';
      if (this.modelOverlayElement) this.modelOverlayElement.hidden = false;
      this.renderModelDrawer();

      try {
        const models = await sub2FetchAccountModels(account.id);
        if (requestSequence !== this.modelRequestSequence) return;
        this.models = models;
        this.savedModelsByAccountId.set(Number(account.id), { status: 'loaded', models });
        this.modelMessage = `已读取 sub2 保存的 ${models.length} 个模型，未访问上游。`;
      } catch (error) {
        if (requestSequence !== this.modelRequestSequence) return;
        this.savedModelsByAccountId.set(Number(account.id), {
          status: 'error',
          models: [],
          error: String(error?.message || error),
        });
        this.modelError = `读取已保存模型失败：${error?.message || error}`;
      } finally {
        if (requestSequence === this.modelRequestSequence) {
          this.modelLoading = false;
          this.renderModelDrawer();
        }
      }
    }

    closeModelDrawer() {
      this.modelRequestSequence += 1;
      this.modelAccount = null;
      this.models = [];
      this.modelFilterText = '';
      this.modelLoading = false;
      this.modelSyncing = false;
      this.modelMessage = '';
      this.modelError = '';
      if (this.modelOverlayElement) this.modelOverlayElement.hidden = true;
    }

    renderModelDrawer() {
      if (!this.modelAccount || !this.modelOverlayElement || !this.modelListElement) return;
      this.modelOverlayElement.hidden = false;
      const accountName = String(this.modelAccount.name || `账号 ${this.modelAccount.id}`).trim() || `账号 ${this.modelAccount.id}`;
      if (this.modelTitleElement) {
        this.modelTitleElement.textContent = `${accountName} · 模型`;
        this.modelTitleElement.title = this.modelTitleElement.textContent;
      }

      if (this.modelSyncButtonElement) {
        this.modelSyncButtonElement.disabled = this.modelLoading || this.modelSyncing;
        this.modelSyncButtonElement.textContent = this.modelSyncing ? '同步中…' : '拉取并同步上游';
      }
      if (this.modelSearchElement) this.modelSearchElement.disabled = this.modelLoading;

      if (this.modelStateElement) {
        this.modelStateElement.classList.toggle('error', Boolean(this.modelError));
        if (this.modelSyncing) {
          this.modelStateElement.textContent = '正在访问上游模型接口并同步，请稍候…';
        } else if (this.modelLoading) {
          this.modelStateElement.textContent = '正在读取 sub2 已保存的模型，不访问上游…';
        } else if (this.modelError) {
          this.modelStateElement.textContent = this.modelError;
        } else {
          this.modelStateElement.textContent = this.modelMessage || `sub2 当前保存了 ${this.models.length} 个模型。`;
        }
      }

      const matchingModels = this.models.filter((model) => {
        if (!this.modelFilterText) return true;
        return [model.id, model.displayName, model.owner, model.type]
          .some((value) => String(value || '').toLocaleLowerCase().includes(this.modelFilterText));
      });

      this.modelListElement.textContent = '';
      if (this.modelLoading) {
        const loading = document.createElement('div');
        loading.className = 'sub2-model-empty';
        loading.textContent = '正在读取…';
        this.modelListElement.appendChild(loading);
        return;
      }

      if (!matchingModels.length) {
        const empty = document.createElement('div');
        empty.className = 'sub2-model-empty';
        empty.textContent = this.models.length
          ? '没有匹配的模型。'
          : 'sub2 当前没有保存模型。需要时可点击“拉取并同步上游”。';
        this.modelListElement.appendChild(empty);
        return;
      }

      for (const model of matchingModels) {
        const item = document.createElement('div');
        item.className = 'sub2-model-item';
        const modelId = document.createElement('span');
        modelId.className = 'sub2-model-id';
        modelId.textContent = model.id;
        modelId.title = model.id;
        item.appendChild(modelId);

        const metadataParts = [];
        if (model.displayName && model.displayName !== model.id) metadataParts.push(model.displayName);
        if (model.owner) metadataParts.push(model.owner);
        if (model.type && model.type !== 'model') metadataParts.push(model.type);
        if (metadataParts.length) {
          const metadata = document.createElement('span');
          metadata.className = 'sub2-model-meta';
          metadata.textContent = metadataParts.join(' · ');
          metadata.title = metadata.textContent;
          item.appendChild(metadata);
        }
        this.modelListElement.appendChild(item);
      }
    }

    async handleSyncModels() {
      if (!this.modelAccount || this.modelLoading || this.modelSyncing) return;
      const account = this.modelAccount;
      const requestSequence = ++this.modelRequestSequence;
      this.modelSyncing = true;
      this.modelMessage = '';
      this.modelError = '';
      this.renderModelDrawer();

      try {
        const models = await sub2SyncAccountModels(account.id);
        if (requestSequence !== this.modelRequestSequence || this.modelAccount?.id !== account.id) return;
        this.models = models;
        this.savedModelsByAccountId.set(Number(account.id), { status: 'loaded', models });
        this.modelMessage = `已从上游拉取并同步 ${models.length} 个模型。`;
      } catch (error) {
        if (requestSequence !== this.modelRequestSequence || this.modelAccount?.id !== account.id) return;
        this.modelError = `上游模型同步失败：${error?.message || error}`;
      } finally {
        if (requestSequence === this.modelRequestSequence && this.modelAccount?.id === account.id) {
          this.modelSyncing = false;
          this.renderModelDrawer();
        }
      }
    }

    renderStatus() {
      if (!this.statusElement) return;
      this.statusElement.classList.toggle('error', Boolean(this.lastError));
      if (this.lastError) {
        this.statusElement.textContent = this.lastError;
        return;
      }
      const when = this.lastUpdatedAt ? sub2FormatRelative(this.lastUpdatedAt, Date.now()) : '刚刚';
      const groupCount = sub2CountDistinctGroups(this.accounts, this.groupsById);
      this.statusElement.textContent = `v${SUB2_SCRIPT_VERSION} · ${groupCount} 个分组 / ${this.accounts.length} 个账号 · 更新于 ${when} · 每 ${SUB2_POLL_SECONDS}s 刷新（后台/最小化/账号编辑暂停，不测活）`;
    }

    setBusy(accountId, busy) {
      if (busy) this.busyIds.add(accountId);
      else this.busyIds.delete(accountId);
      this.renderList();
    }

    async handleToggleSchedulable(account) {
      const target = !(account.schedulable !== false);
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

    async handleCapacity(account, rawCapacity) {
      if (this.capacitySaving || this.quotaSaving) return;
      const parsedCapacity = sub2ParseCapacityInput(rawCapacity);
      if (parsedCapacity.error) {
        this.lastError = parsedCapacity.error;
        this.renderStatus();
        return;
      }

      const currentCapacity = Number(account?.concurrency);
      if (parsedCapacity.value === currentCapacity) {
        this.lastError = '';
        this.renderStatus();
        return;
      }

      let updateSucceeded = false;
      this.capacitySaving = true;
      this.refreshRequestSequence += 1;
      this.pendingRefresh = false;
      try {
        await sub2UpdateCapacity(account, parsedCapacity.value);
        this.lastError = '';
        updateSucceeded = true;
      } catch (error) {
        this.lastError = `设置容量失败：${error?.message || error}`;
        this.renderStatus();
      } finally {
        this.capacitySaving = false;
        if (updateSucceeded) {
          // 成功后刷新账号配置和 Ops 快照；失败时保留编辑器及输入值以便重试。
          this.renderList();
          await this.refresh();
        }
      }
    }

    async handleDailyQuota(account, rawDailyLimit) {
      if (this.quotaSaving || this.capacitySaving) return;
      let dailyLimit = null;
      if (rawDailyLimit !== null) {
        const normalizedValue = String(rawDailyLimit || '').trim();
        const numericValue = Number(normalizedValue);
        if (!normalizedValue || !Number.isFinite(numericValue) || numericValue <= 0) {
          this.lastError = '日配额必须是大于 0 的美元金额；如需关闭请点击“取消限制”。';
          this.renderStatus();
          return;
        }
        dailyLimit = Math.round(numericValue * 100) / 100;
        if (!Number.isFinite(dailyLimit)) {
          this.lastError = '日配额金额过大，请输入较小的美元金额。';
          this.renderStatus();
          return;
        }
        if (dailyLimit < 0.01) {
          this.lastError = '日配额最小为 $0.01。';
          this.renderStatus();
          return;
        }
      }

      let updateSucceeded = false;
      this.quotaSaving = true;
      this.refreshRequestSequence += 1;
      this.pendingRefresh = false;
      try {
        await sub2UpdateDailyQuota(account, dailyLimit);
        this.lastError = '';
        updateSucceeded = true;
      } catch (error) {
        this.lastError = `设置日配额失败：${error?.message || error}`;
        this.renderStatus();
      } finally {
        this.quotaSaving = false;
        if (updateSucceeded) {
          // 成功后才关闭编辑器并刷新；失败时保留原输入，便于直接修正或重试。
          this.renderList();
          await this.refresh();
        }
      }
    }
  }


  return {
    Sub2Controller,
    sub2NormalizeModels,
    sub2GetNumericAccountField,
    sub2ParseTimestamp,
    sub2IsQuotaPeriodExpired,
    sub2GetQuotaUsageSnapshot,
    sub2NormalizeConcurrencySnapshot,
    sub2ResolveAccountConcurrency,
    sub2SummarizeConcurrency,
    sub2SupportsDailyQuota,
    sub2GetUpstreamBaseUrl,
    sub2GetUpstreamWebsiteUrl,
    sub2GetPoolModeState,
    sub2BuildDailyQuotaExtra,
    sub2GetPaginatedItems,
    sub2IsPaginatedPayloadComplete,
    sub2NormalizeRequestHistory,
    sub2GetRequestHistoryKey,
    sub2AnnotateRequestHistory,
    sub2NormalizeRecentRequest,
    sub2ParseCapacityInput,
    sub2ExtractRoutingStatusCode,
    sub2NormalizeRoutingError,
    sub2GetCorrelatedRoutingErrors,
    sub2NormalizeRoutingErrors,
    sub2IsTrackedReliabilityStatus,
    sub2GetReliabilityEventType,
    sub2NormalizeLocalEvent,
    sub2NormalizeEventRetentionDays,
    sub2PruneLocalEvents,
    sub2MergeLocalEvents,
    sub2BuildRequestStatusEvents,
    sub2NormalizeObservationSnapshot,
    sub2BuildObservationSnapshot,
    sub2BuildObservationTransitionEvents,
    sub2BuildReliabilitySnapshot,
    sub2GetAccountRestrictionState,
    sub2AuditGroupSinglePointRisks,
    sub2AuditPlatformAndModelConfig,
    sub2AuditPrimaryAccountAvailability,
    sub2BuildConfigAudit,
    sub2BuildCapacityAdvice,
    sub2BuildRouteChain,
    sub2BuildRecentRoutingErrorIndex,
    sub2MergeRouteFailuresIntoErrorIndex,
    sub2ResolveLatestHit,
    sub2BuildRoutingExplanation,
    sub2GetEffectivePriority,
    sub2ModelPatternMatches,
    sub2NormalizeRequestedModelForLookup,
    sub2EvaluateModelSupport,
    sub2EvaluateCandidateEligibility,
    start() {
      if (isSub2Host()) {
        new Sub2Controller().start();
      }
    },
  };
});
