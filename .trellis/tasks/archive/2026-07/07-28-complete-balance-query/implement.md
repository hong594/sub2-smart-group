# 补全余额查询实施计划

## 1. Registry And Pure Contracts

- [x] 将 29 个当前 hostname 写入冻结协议注册表，删除两个过期项，并从注册表生成运行时 allowlist。
- [x] 同步 userscript 精确 `@connect` metadata；增加静态断言确保 metadata、运行时 allowlist 和注册表键完全一致且没有通配符。
- [x] 增加账号 base URL 规范化、自动资格解析、导出项绑定和 New API quota 解析纯函数，并通过 CommonJS 暴露给 Node 断言。

Rollback point: 仅 metadata、常量和无副作用纯函数；尚未改变查询或 UI。

## 2. Configuration Compatibility And UX

- [x] 把余额配置规范化为 `auto` / `manual` tagged mode；无 `mode` 旧配置按 manual 读取。
- [x] 自动配置只持久化模式与低余额阈值，手工配置保留现有 provider/origin/credential 绑定。
- [x] 更新余额编辑器：自动合格账号默认可直接查询；模式选择控制自动阈值字段与高级手工字段；切换/关闭仍清空未保存秘密。
- [x] 确保从手工保存为自动时 GM 值不再包含旧手工秘密，清除后恢复基于账号注册表的默认行为。

Rollback point: 新解析器仍能读取旧配置；尚未接入单账号导出，可恢复旧 editor/query resolution。

## 3. Single-Account Export Boundary

- [x] 增加只接受正整数 ID 的 `/admin/accounts/data?ids=<id>&include_proxies=false` 同源调用。
- [x] 要求恰好一条账号响应，并在读取 `api_key` 前复核名称、平台、类型和完整规范化 base URL。
- [x] 对响应无 ID 的限制写出明确函数命名和错误，不制造“已核对响应 ID”的假保证。
- [x] Key 与导出对象只返回给当前查询闭包；在 `finally` 中清空和丢弃引用。

Rollback point: 导出 helper 尚未成为任何自动调用路径，可独立删除。

## 4. Strict External Protocols

- [x] 抽取单次严格 JSON GET 边界，保留 anonymous、no-cache、15 秒超时、拒绝重定向和 final URL 字面核对。
- [x] sub2api 自动模式使用导出 Key 请求固定 `/v1/usage`，复用现有严格解析。
- [x] New API 先无凭据请求 `/api/status`，验证正数 `quota_per_unit` 后再带导出 Key 请求 `/api/usage/token/`。
- [x] 用动态 divisor 解析有限余额、已用和总额；增加无限额度结果并移除自动路径中的 `500000` 假设。
- [x] 所有错误保持脱敏；一次点击不自动重试、不协议切换、不在自动失败后改走手工凭据。

Rollback point: 手工 query builder 保持可用；自动协议可按 provider 分别回退。

## 5. Controller And Evidence Rendering

- [x] 将可信 query 点击解析为 auto 或 manual，并保证 export 与全部外部请求都位于该次点击调用链内。
- [x] 查询期间继续暂停刷新；loading/error 保留上一次成功结果，不把导出对象或 Key写入 controller state。
- [x] 显示协议、有限余额或“无限额度”、币种和查询时间；无限额度抑制低余额与续航，今日消费可独立保留。
- [x] 核对启动、refresh、timer、visibility、筛选、排序和 render 路径都无法调用导出或外部查询。

Rollback point: controller 接线为最后行为切换点；失败时可恢复旧 `handleBalanceQuery` 而不改 GM 数据。

## 6. Documentation And Specs

- [x] 更新 README 的余额操作、协议、凭据来源、权限列表、安全边界和局限。
- [x] 更新 `.trellis/spec/frontend/manual-balance-monitoring.md` 的自动导出、动态 quota、无限额度和旧配置兼容合同。
- [x] 如 editor schema/切换不变量变化，同步 `.trellis/spec/frontend/account-editors-and-audit.md`。
- [x] 不把 All API Hub 备份、真实响应、真实 Key、Token、Cookie 或密码写入仓库。

## 7. Focused Verification

用 `apply_patch` 创建临时 Node 断言文件，使用明显的假账号和假 Key；完成后删除。覆盖：

- [x] 29 域名协议映射、unknown/manual-only、metadata parity、HTTPS/端口/重定向限制。
- [x] 单 ID URL、单条导出、无响应 ID 的元数据绑定、名称/平台/类型/base URL 不一致拒绝，以及通过验证前不读取/发送 Key。
- [x] 旧配置解析、隐式 auto、显式 manual、auto 仅存阈值、切换到 auto 丢弃旧秘密。
- [x] sub2api 固定路径；New API 严格两阶段顺序、status 失败不发 Key、动态 `quota_per_unit`、无效数值和无限额度。
- [x] 无限额度、有限 USD、非 USD、低余额、今日证据和续航抑制；失败保留上次成功证据。
- [x] 可信点击唯一入口，启动/刷新/筛选/排序/timer/render 不触发导出或外部请求。
- [x] 现有 editor 与余额回归已重跑；请求历史、可靠性、配额、容量、账号创建和模型同步确认无代码差异，并沿用 v2.6.0 已通过的完整回归基线。

执行并记录：

```powershell
node --check .\sub2-smart-group.user.js
node .\.tmp-balance-query.test.cjs
rg -n "handleBalanceQuery|sub2QueryUpstreamBalance|accounts/data|GM_xmlhttpRequest" .\sub2-smart-group.user.js
rg -n "sub\.100xlabs\.space|new\.ambition\.qz\.io|@connect\s+\*" .\sub2-smart-group.user.js .\README.md .\.trellis\spec
git diff --check
git status --short
```

最后删除临时测试文件，并对 diff 做秘密模式检查；只报告命中位置和类别，不输出任何疑似秘密值。

## 8. Review Gates

- [x] Trellis implement review 核对 PRD 每项 acceptance criterion。
- [x] Trellis check 运行完整静态、Node 和跨层数据流检查。
- [x] 在提交前更新相关 spec，确认工作区原有无关改动未被纳入或回退。
- [x] 只有验证通过后才进入提交和任务归档流程。

## Verification Record

- 2026-07-28: `node --check .\sub2-smart-group.user.js` passed.
- 2026-07-28: focused fake-secret Node assertions passed, including trusted-trigger, single-export binding, protocol order, redirect rejection, dynamic quota, unlimited quota, stale evidence, storage, editor, and secret-lifetime cases; the temporary test file was then deleted.
- 2026-07-28: request-history, reliability, quota, capacity, account-creation, and model-sync helpers had no code diff from the v2.6.0 full-regression baseline; the current CommonJS factory still loaded successfully in the focused Node run.
- 2026-07-28: static call-site review found export and external balance query calls only inside `handleBalanceQuery`, whose only two callers descend from trusted click checks.
- 2026-07-28: obsolete-host, wildcard `@connect`, and hardcoded-divisor search returned no matches in userscript, README, or frontend specs.
- 2026-07-28: secret-literal scan returned no suspicious matches; task JSON/JSONL parsing and `git diff --check` passed.
