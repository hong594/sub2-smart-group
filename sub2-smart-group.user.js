// ==UserScript==
// @name         Sub2 Smart Group
// @name:zh-CN   Sub2 智能分组
// @namespace    local.sub2.smart-group
// @version      2.0.0
// @description  Sub2 account health, routing, quota controls, and manual upstream model sync (no active health probing).
// @description:zh-CN 为 sub2api 提供账号健康度、路由管理、配额控制与手动上游模型同步（不主动测活）
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
  // 手动操作（不读取或提交 API Key）：
  //   POST /api/v1/admin/accounts/:id/schedulable      摘出 / 挂回调度池
  //   POST /api/v1/admin/accounts/:id/recover-state    清除冷却 / 恢复
  //   PUT  /api/v1/admin/accounts/:id                  仅调整账号优先级
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
  const SUB2_SCRIPT_VERSION = typeof GM_info !== 'undefined' && GM_info?.script?.version
    ? String(GM_info.script.version)
    : '2.0.0';
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

  function sub2GetNumericAccountField(account, fieldName) {
    const value = account?.[fieldName] ?? account?.extra?.[fieldName];
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
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

  function sub2NormalizeRecentRequest(payload) {
    const recentRequest = sub2GetPaginatedItems(payload).find((item) => item?.kind === 'success') || null;
    if (!recentRequest) return null;

    const accountId = Number(recentRequest.account_id);
    const createdAt = Date.parse(recentRequest.created_at);
    if (!Number.isInteger(accountId) || accountId <= 0 || !Number.isFinite(createdAt)) return null;

    const numericGroupId = Number(recentRequest.group_id);
    return {
      accountId,
      createdAt,
      groupId: Number.isInteger(numericGroupId) && numericGroupId > 0 ? numericGroupId : null,
      platform: String(recentRequest.platform || '').trim(),
      model: String(recentRequest.model || '').trim(),
      requestId: String(recentRequest.request_id || '').trim(),
      source: 'ops',
    };
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
    return String(value || '').trim().replace(/^client:/i, '');
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
      accountId,
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

  function sub2BuildRecentRoutingErrorIndex(payload, recentRequest = null) {
    const errorByAccountId = new Map();
    const recentCorrelationId = sub2NormalizeCorrelationId(recentRequest?.requestId);
    for (const errorItem of sub2GetPaginatedItems(payload)) {
      const normalizedError = sub2NormalizeRoutingError(errorItem);
      if (!normalizedError) continue;
      const errorCorrelationIds = [normalizedError.requestId, normalizedError.clientRequestId]
        .map(sub2NormalizeCorrelationId)
        .filter(Boolean);
      normalizedError.correlated = Boolean(recentCorrelationId && errorCorrelationIds.includes(recentCorrelationId));
      const previousError = errorByAccountId.get(normalizedError.accountId);
      const replacesPrevious = !previousError
        || (normalizedError.correlated && !previousError.correlated)
        || (normalizedError.correlated === previousError.correlated && normalizedError.createdAt > previousError.createdAt);
      if (replacesPrevious) {
        errorByAccountId.set(normalizedError.accountId, normalizedError);
      }
    }
    return errorByAccountId;
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

    if (!latestHit || (Number(account?.priority) || 0) >= latestHit.priority) return null;

    const health = sub2ComputeHealth(account, now);
    if (health.tone !== 'ok') {
      return {
        tone: 'inferred',
        evidence: '当前状态',
        text: `当前不可正常调度：${health.reasons.join('；')}；可能是未命中原因，但 sub2 未保存当时的候选状态`,
      };
    }

    if (latestHit.platform && String(account?.platform || '').trim() !== latestHit.platform) {
      return {
        tone: 'inferred',
        evidence: '配置判断',
        text: `账号当前平台与最近请求平台 ${latestHit.platform} 不同，通常不会进入该请求候选`,
      };
    }

    if (latestHit.groupId) {
      const memberships = sub2GetGroupMemberships(account, context.groupsById);
      const belongsToRequestGroup = memberships.some((membership) => membership.groupId === latestHit.groupId);
      if (!belongsToRequestGroup) {
        const requestGroup = sub2GetIndexedGroup(context.groupsById, latestHit.groupId);
        const requestGroupName = String(requestGroup?.name || `分组 ${latestHit.groupId}`).trim();
        return {
          tone: 'inferred',
          evidence: '配置判断',
          text: `账号当前不在最近请求分组「${requestGroupName}」，通常不会进入该请求候选`,
        };
      }
    }

    const accountLastUsedAt = Date.parse(account?.last_used_at);
    const hasRecentAccountActivity = Number.isFinite(accountLastUsedAt)
      && Math.abs(latestHit.createdAt - accountLastUsedAt) <= SUB2_ROUTING_LOOKBACK_MS;
    if (context.errorsAvailable === false) {
      return {
        tone: 'inferred',
        evidence: '推测',
        text: '较高优先级状态正常；运维故障明细不可用，可能因会话粘连、分组/模型匹配或调度权重未选中',
      };
    }
    return {
      tone: 'inferred',
      evidence: '推测',
      text: hasRecentAccountActivity
        ? '较高优先级状态正常且近期用过；可能因会话粘连、模型匹配或高级调度权重未选中'
        : '较高优先级未发现近期请求/失败；可能未进入候选，或被会话粘连、模型匹配、调度权重跳过',
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
    const [requestResult, errorResult] = await Promise.allSettled([
      sub2ApiRequestWithTimeout(
        'GET',
        '/admin/ops/requests?time_range=30m&kind=success&sort=created_at_desc&page=1&page_size=1',
      ),
      sub2ApiRequestWithTimeout(
        'GET',
        '/admin/ops/upstream-errors?time_range=30m&page=1&page_size=200',
      ),
    ]);

    const recentRequest = requestResult.status === 'fulfilled'
      ? sub2NormalizeRecentRequest(requestResult.value)
      : null;
    return {
      requestsAvailable: requestResult.status === 'fulfilled',
      errorsAvailable: errorResult.status === 'fulfilled',
      recentRequest,
      errorByAccountId: errorResult.status === 'fulfilled'
        ? sub2BuildRecentRoutingErrorIndex(errorResult.value, recentRequest)
        : new Map(),
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
    #${SUB2_PANEL_ID} .sub2-summary{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #f1f5f9;}
    #${SUB2_PANEL_ID} .sub2-chip{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;}
    #${SUB2_PANEL_ID} .sub2-chip.ok{background:#dcfce7;color:#166534;}
    #${SUB2_PANEL_ID} .sub2-chip.warn{background:#fef9c3;color:#854d0e;}
    #${SUB2_PANEL_ID} .sub2-chip.paused{background:#e2e8f0;color:#475569;}
    #${SUB2_PANEL_ID} .sub2-chip.down{background:#fee2e2;color:#991b1b;}
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
    #${SUB2_PANEL_ID} .sub2-hit-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;
      background:#cffafe;color:#155e75;border:1px solid #67e8f9;font-size:10px;font-weight:750;white-space:nowrap;}
    #${SUB2_PANEL_ID} .sub2-hit-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:#06b6d4;
      box-shadow:0 0 0 3px rgba(6,182,212,.14);}
    #${SUB2_PANEL_ID} .sub2-platform{font-size:11px;color:#64748b;}
    #${SUB2_PANEL_ID} .sub2-meta{font-size:12px;color:#475569;display:flex;flex-wrap:wrap;gap:6px 9px;}
    #${SUB2_PANEL_ID} .sub2-quota-summary{font-weight:600;color:#0369a1;}
    #${SUB2_PANEL_ID} .sub2-quota-summary.warn{color:#b45309;}
    #${SUB2_PANEL_ID} .sub2-quota-summary.down{color:#b91c1c;}
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
      this.accounts = [];
      this.groupsById = new Map();
      this.statsById = {};
      this.recentRequest = null;
      this.latestHit = null;
      this.recentRoutingErrorByAccountId = new Map();
      this.routingRequestsAvailable = false;
      this.routingErrorsAvailable = false;
      this.routingRequestSequence = 0;
      this.refreshTimer = null;
      this.tickTimer = null;
      this.visibilityHandler = null;
      this.loading = false;
      this.pendingRefresh = false;
      this.refreshRequestSequence = 0;
      this.quotaSaving = false;
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
    }

    start() {
      if (typeof GM_addStyle === 'function') GM_addStyle(SUB2_STYLE);
      this.mount();
      this.refresh();
      this.refreshTimer = window.setInterval(() => {
        if (!this.minimized && document.visibilityState !== 'hidden' && !this.isQuotaInteractionActive()) this.refresh();
      }, SUB2_POLL_SECONDS * 1000);
      this.visibilityHandler = () => {
        if (!this.minimized && document.visibilityState === 'visible' && !this.isQuotaInteractionActive()) this.refresh();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      // 每秒重绘倒计时：仅当存在“冷却中”的账号时才重建列表，
      // 避免无谓的每秒全量重建把滚动位置顶掉（会表现为面板每秒自己往下滚）。
      this.tickTimer = window.setInterval(() => {
        if (this.minimized || !this.accounts.length || this.isQuotaInteractionActive()) return;
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
          <button class="sub2-min" title="最小化">—</button>
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

      this.viewElement.value = this.viewMode;
      this.sortElement.value = this.sortMode;
      this.root.querySelector('.sub2-min').addEventListener('click', () => this.setMinimized(true));
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

      this.applyMinimized();
    }

    hasOpenQuotaEditor() {
      return Boolean(this.root?.querySelector('.sub2-quota-editor:not([hidden])'));
    }

    isQuotaInteractionActive() {
      return this.quotaSaving || this.hasOpenQuotaEditor();
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
      if (this.isQuotaInteractionActive()) return;

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

        if (requestSequence !== this.refreshRequestSequence || this.isQuotaInteractionActive()) return;

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
        if (requestSequence === this.refreshRequestSequence && !this.isQuotaInteractionActive()) {
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
        if (this.pendingRefresh && !this.isQuotaInteractionActive()) {
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
        || this.isQuotaInteractionActive()
      ) {
        return;
      }

      this.routingRequestsAvailable = routingActivity.requestsAvailable;
      this.routingErrorsAvailable = routingActivity.errorsAvailable;
      this.recentRequest = routingActivity.requestsAvailable ? routingActivity.recentRequest : null;
      this.recentRoutingErrorByAccountId = routingActivity.errorsAvailable
        ? routingActivity.errorByAccountId
        : new Map();
      this.latestHit = sub2ResolveLatestHit(
        this.accounts,
        this.recentRequest,
        !this.routingRequestsAvailable,
      );
      this.renderList();
    }

    render() {
      this.renderSummary();
      this.renderFilters();
      this.renderList();
      this.renderStatus();
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
      this.summaryElement.innerHTML = `
        <span class="sub2-chip ok">正常 ${counts.ok}</span>
        <span class="sub2-chip warn">注意 ${counts.warn}</span>
        <span class="sub2-chip down">不可用 ${counts.down}</span>
        <span class="sub2-chip paused">已停用 ${counts.paused}</span>
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
        const latestHitBadge = document.createElement('span');
        latestHitBadge.className = 'sub2-hit-badge';
        latestHitBadge.textContent = '最近命中';
        latestHitBadge.title = `最近成功请求：${sub2FormatRelative(this.latestHit.createdAt, now)}`;
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

      const routingExplanation = sub2BuildRoutingExplanation(account, {
        latestHit: this.latestHit,
        recentError: this.recentRoutingErrorByAccountId.get(Number(account.id)) || null,
        groupsById: this.groupsById,
        errorsAvailable: this.routingErrorsAvailable,
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
      return row;
    }

    async openModelDrawer(account) {
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
        this.modelMessage = `已读取 sub2 保存的 ${models.length} 个模型，未访问上游。`;
      } catch (error) {
        if (requestSequence !== this.modelRequestSequence) return;
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
      this.statusElement.textContent = `v${SUB2_SCRIPT_VERSION} · ${groupCount} 个分组 / ${this.accounts.length} 个账号 · 更新于 ${when} · 每 ${SUB2_POLL_SECONDS}s 刷新（后台/最小化/配额编辑暂停，不测活）`;
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

    async handleDailyQuota(account, rawDailyLimit) {
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
      this.setBusy(account.id, true);
      try {
        await sub2UpdateDailyQuota(account, dailyLimit);
        this.lastError = '';
        updateSucceeded = true;
      } catch (error) {
        this.lastError = `设置日配额失败：${error?.message || error}`;
        this.renderStatus();
      } finally {
        this.quotaSaving = false;
        this.setBusy(account.id, false);
        if (updateSucceeded) await this.refresh();
      }
    }
  }


  return {
    sub2NormalizeModels,
    sub2GetNumericAccountField,
    sub2SupportsDailyQuota,
    sub2GetUpstreamBaseUrl,
    sub2GetUpstreamWebsiteUrl,
    sub2GetPoolModeState,
    sub2BuildDailyQuotaExtra,
    sub2GetPaginatedItems,
    sub2NormalizeRecentRequest,
    sub2ExtractRoutingStatusCode,
    sub2NormalizeRoutingError,
    sub2BuildRecentRoutingErrorIndex,
    sub2ResolveLatestHit,
    sub2BuildRoutingExplanation,
    start() {
      if (isSub2Host()) {
        new Sub2Controller().start();
      }
    },
  };
});
