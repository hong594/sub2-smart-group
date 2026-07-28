# 补全余额查询技术设计

## Boundaries

实现仍限制在 userscript 和文档层：

- `sub2-smart-group.user.js` 负责同源单账号导出、跨域余额请求、配置迁移、结果归一和 UI 状态。
- `README.md` 说明用户可见行为、安全边界和协议限制。
- `.trellis/spec/frontend/manual-balance-monitoring.md` 与相关前端规范在实现验证后更新。
- 不修改 sub2 后端、容器、数据库、调度或账号健康状态。

上游合同固定到本次核验的源码：

- sub2api `v0.1.166` / revision `dc893dd0b8eab41df5be595ae9fcd1aa74a062b8`：`backend/internal/handler/admin/account_data.go`。
- New API revision `b08febaa`：`controller/token.go` 的 `GetTokenUsage` 与 `controller/misc.go` 的 `GetStatus`。

## Protocol Registry

代码使用一个冻结的 hostname 注册表作为协议和跨域权限的单一运行时来源，`SUB2_BALANCE_ALLOWED_HOSTS` 从其键生成；userscript metadata 中的 `@connect` 仍需静态列出，并由测试核对完全一致。

| Protocol | Exact hosts |
|---|---|
| `newapi` | `api.ark717.com`, `api.hlool.top`, `muyuan.do`, `welfare.0xpsyche.me`, `windhub.cc`, `metapi.lilililwan.xyz`, `api.123nhh.com`, `ooioo.work`, `api.maoyulin.xyz`, `new.ambition.qzz.io`, `jianzhile.vip`, `runanytime.hxi.me`, `ai.venlacy.com`, `aitoken.forum`, `new.397710.xyz`, `ai.52ccl.cn`, `api.7x.hk`, `ai.centos.hk`, `ai.hubijun.vip`, `gancaopu.com`, `free.lyclaude.site`, `x666.me`, `elysiver.h-e.top` |
| `sub2api` | `api.aijws.com`, `icoe.pp.ua`, `aihub.top`, `api.ambition.qzz.io`, `sub2.zmoon.top` |
| unknown/manual-only | `kuai.dmxcode.com` |

注册表未知或标记为 manual-only 的 host 不具备自动查询资格。精确许可不等于协议推断；手工兼容模式仍必须有用户保存的明确 provider 配置。

## Query Resolution

新增纯函数根据当前账号和已存配置解析查询模式：

1. 账号 ID 必须是正整数。
2. 若存在旧手工配置或用户显式选择手工模式，按该配置执行现有合同。
3. 否则，账号必须是 `type=apikey`，其规范化 hostname 必须在注册表中且协议已知，才返回自动查询描述。
4. 其余账号返回不可自动查询原因，按钮打开余额设置而不是访问网络。

自动查询描述只包含账号绑定所需的非秘密行数据和注册表协议；不缓存 Key。

## Single-Account Export And Binding

### Request

同一次可信点击中调用：

```text
GET /api/v1/admin/accounts/data?ids=<positive-account-id>&include_proxies=false
Authorization: Bearer <current-sub2-admin-token>
credentials: same-origin
```

现有 `sub2ApiRequest()` 会解包统一响应的 `data`，因此解析对象应为 `DataPayload`，并要求 `accounts` 恰好有一项。

### Response Limitation

sub2 的 `DataAccount` 只包含 `name`、`platform`、`type`、`credentials` 等字段，不包含 ID。不能声称“从响应核对 ID”。绑定由以下条件共同建立：

- 请求 URL 只包含当前行的一个正整数 ID；
- `include_proxies=false`，不扩大秘密暴露面；
- 响应 `accounts.length === 1`；
- 导出项与当前行的名称精确 trim 后一致；
- 平台和类型 trim 后按小写一致；
- 当前行和导出项的 `base_url` 都通过同一 URL 规范化函数，完整规范化值一致。

完整地址规范化允许账号 API base URL 自带路径，但拒绝内嵌凭据、查询、片段、非 HTTPS 和自定义端口。余额请求只从验证后的导出 URL 提取 HTTPS origin，再拼接注册表固定路径。元数据全部通过后才读取 `credentials.api_key`；Key 必须是无 CR/LF 的非空字符串。

## External Request Pipeline

将现有 `GM_xmlhttpRequest` 边界拆成“单个严格 JSON GET”和“协议编排”两层，复用以下不变量：

- `anonymous: true`, `nocache: true`, `redirect: 'error'`；
- 15 秒超时和 watchdog abort；
- 仅接受 2xx 和有效 JSON 对象；
- `response.finalUrl` 必须存在并与请求 URL 字面完全一致；
- 固定、脱敏错误，不拼接响应正文、请求头或 Key。

### sub2api

```text
GET <validated-origin>/v1/usage
Authorization: Bearer <exported-api-key>
```

保留现有 `remaining ?? quota.remaining ?? balance`、单位和 `is_active ?? isValid ?? true` 合同。结果可保留上游明确返回的非 USD 单位；非 USD 继续抑制续航。

### New API

步骤一不带 Key：

```text
GET <validated-origin>/api/status
```

必须满足 `success === true`、`data` 为普通对象、`quota_per_unit` 是严格有限正数。验证失败即终止，不发送 Key。

步骤二才带 Key：

```text
GET <validated-origin>/api/usage/token/
Authorization: Bearer <exported-api-key>
```

必须满足 `code === true`、`data` 为普通对象。有限额度要求 `total_available`、`total_used` 和 `total_granted` 均为有限非负数，分别除以本次 status 返回的 `quota_per_unit`，结果单位固定为 `USD`。`unlimited_quota === true` 时返回无限额度结果，不以 `total_available` 构造有限余额；`expires_at` 和名称只作为经过清洗的附加信息。

## Result Model And Rendering

余额结果扩展为两种明确形态：

```javascript
{ isValid: true, unlimited: false, remaining, used, total, unit, provider, ... }
{ isValid: true, unlimited: true, remaining: null, unit: 'USD', provider: 'newapi', ... }
```

- 有限结果沿用现有低余额和 USD 续航逻辑。
- 无限结果显示“无限额度”，`lowBalance=false`，不计算续航；今日消费仍可独立显示。
- loading 和 error 状态保留上一次成功结果作为 stale evidence，避免一次失败抹掉已经确认的余额。错误文本只描述失败阶段和修正方向。
- 查询期间继续暂停自动刷新，最终只重绘当前列表状态，不新增轮询路径。

## Configuration UX And Migration

配置采用 tagged mode，并继续使用原来的“sub2 origin + account ID”GM key：

```javascript
{ mode: 'auto', lowBalanceThreshold: number | null }
{ mode: 'manual', type, baseUrl, lowBalanceThreshold, ...legacyCredentialFields }
```

- 已有无 `mode` 的合法配置规范化为 `manual`，不静默迁移、不删除秘密，原查询行为保持不变。
- 没有配置且具备自动资格的账号使用隐式 `auto`，无需先写 GM 存储。
- 余额设置增加模式选择。自动模式只显示/保存阈值和模式；手工兼容模式显示现有 provider、base URL 和凭据字段。
- 从手工切到自动并保存会覆盖为无秘密 auto 配置。清除设置仍需确认，并恢复该账号的默认模式。
- 自动查询失败不自动调用手工路径，避免一次点击产生不可见的第二次凭据发送。

## Secret Lifetime

自动流程中的导出载荷和 Key 只由 `handleBalanceQuery()` 的一次调用持有：

1. 元数据验证完成后读取 Key。
2. 立即构造并等待固定协议请求，不写 controller state。
3. state 中只保存归一化余额结果或脱敏错误。
4. `finally` 中把 Key 设为空字符串、导出对象设为 `null`，并释放请求中的局部引用。

这是引用生命周期约束，不宣称物理内存清零。测试只使用明显的假 Key，并验证返回对象、state、DOM 和持久化配置中均无该字符串。

## Compatibility And Failure Policy

- 保留 CommonJS factory/export 形态和现有纯函数回归。
- 保留旧手工端点和凭据绑定规则；新自动路径不改变旧配置的目的地。
- 不支持、导出不完整、绑定不一致、status 合同错误、鉴权失败、超时、非白名单和重定向都只产生脱敏错误。
- 不自动重试，不在 New API 与 sub2api 间切换，不覆盖上次成功证据。

## Rollback

本功能没有数据迁移和后台变更。回滚只需恢复 userscript、README 和余额规范；旧手工 GM 配置仍是向后兼容格式。实现应在配置 schema、单账号导出、外部协议和 UI 接线四个阶段分别保持可审查 diff，便于局部回退。
