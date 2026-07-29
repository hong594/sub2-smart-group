# 余额查询方法判定与 All API Hub 补充实施计划

## 1. Method Resolver And Query Routing

- [ ] 增加纯 `sub2BuildBalanceSetupState()`，统一验证账号、规范化地址、查询注册表、分类方法、必需字段、缺失字段和查询资格。
- [ ] 调整 `sub2ResolveBalanceQuery()`：sub2api 始终走单账号导出 Key + `/v1/usage`；New API 只走完整 Access Token + User ID 的 `/api/status` + `/api/user/self`。
- [ ] New API 缺凭据、查询失败或旧 `mode:auto` 时不得到达 `/api/usage/token/`；未知、协议为空和冲突站点不得构造查询。
- [ ] 保留合法低余额阈值；旧手工 sub2api 凭据不参与请求且不自动删除。
- [ ] 通过 CommonJS 暴露方法解析纯函数，供聚焦 Node 断言使用。

Rollback point: 只切换纯解析与查询决策；GM 数据格式尚未改变，可恢复旧 resolver。

## 2. Missing-Field Balance Editor

- [ ] 从单账号编辑器移除可见“自动 / 手工模式”、来源类型选择器和可编辑 origin。
- [ ] 显示已确定的方法、规范化站点、信息完整性和固定脱敏原因。
- [ ] sub2api 只显示“直接使用 sub2 已保存的 Key”与可选阈值，不显示凭据输入。
- [ ] New API 完整配置显示“信息已齐全”，不回填凭据；缺失/冲突配置只显示当前方法所缺 Access Token / User ID。
- [ ] unsupported 状态不显示凭据或保存并查询；query 按钮改为“补充信息”或明确不可用状态。
- [ ] 正整数 ID 的 apikey 账号始终保留余额设置入口；unsupported 查询不可执行，但固定原因必须可查看。
- [ ] 保持保存、保存并查询、取消和明确清除设置的可信点击、草稿互斥、焦点与刷新暂停合同。
- [ ] 将余额草稿的 method/provider/origin 改为账号派生且不可编辑，只保留阈值和当前缺失 New API 凭据为可编辑字段。

Rollback point: UI 只消费 Method Resolver；旧 GM 配置仍可由旧版编辑器读取。

## 3. Import Plan Classification

- [ ] 保留并收紧备份根 schema、候选项、URL、协议与 New API 凭据校验。
- [ ] 导入始终使用 controller 完整账号列表，不受筛选、排序、分组视图或当前渲染数量影响。
- [ ] 保持 hostname 唯一匹配与精确名称消歧；重复、无匹配、禁用、无效与协议冲突不得猜测。
- [ ] 将计划分类改为 `missing`、`conflict`、`complete`、`directSub2api`、`ambiguous`、`unmatched`、`skipped`。
- [ ] 完整且绑定正确的 New API 配置不生成写入；缺失/冲突项确认后写入现有兼容配置并保留阈值。
- [ ] sub2api 不读取或保存备份 Access Token；`apiCredentialProfiles` 完全不进入计划。
- [ ] 更新脱敏预览和结果文案，分别报告将补充、将纠正、已齐全、可直接查询及跳过计数。

Rollback point: 删除导入按钮接线即可停止新导入；已确认写入仍是旧版兼容 New API 配置。

## 4. Secret Lifetime And Compatibility Cleanup

- [ ] 保持 `balanceConfigsById` 只存无秘密摘要；Method Resolver 和渲染不得读取完整 GM 凭据。
- [ ] 查询/保存边界局部加载完整 New API 配置，并在 `finally` 清空复制字段和引用。
- [ ] sub2api 查询只读取当次单账号导出 Key；确认旧手工 GM Key 没有请求消费者。
- [ ] 增加阈值局部合并边界：保存阈值时保留已有 New API 完整凭据和旧手工 sub2api 配置；无旧配置的 sub2api 才保存无秘密 auto + threshold。
- [ ] 审查 `/api/usage/token/` helper、exports 和测试消费者；确认为无消费者后删除，否则保留为不可达兼容代码并记录原因。
- [ ] 保持 GM storage key 和 New API 配置 schema 不变，不批量迁移或物理删除旧配置。

## 5. Documentation And Version

- [ ] userscript metadata 与 fallback 版本保持 `2.7.1`。
- [ ] 更新 README：方法先判定、sub2api 直接查询、New API 账号余额、只补缺项、导入分类与无回退规则。
- [ ] 更新 `.trellis/spec/frontend/manual-balance-monitoring.md`：Method Resolver、旧配置解析、导入补充和秘密生命周期合同。
- [ ] 更新 `.trellis/spec/frontend/account-editors-and-audit.md`：账号派生余额方法、缺失字段草稿、隐藏凭据阈值合并和现有互斥/清理合同。
- [ ] 不记录真实备份路径、账号名、hostname、Token、User ID 或原始响应；只允许脱敏计数证据。

## 6. Focused Verification

扩展现有临时 `.tmp-balance-import.test.cjs`，只使用明显虚构的账号与凭据，验证后删除：

- [ ] Method Resolver 覆盖 sub2api、New API 完整/缺失/冲突、旧 auto/manual、未知 hostname、协议为空、非 apikey 和无效地址。
- [ ] query resolver 证明 sub2api 只走导出 Key，New API 只走账号余额，缺失/失败没有模型 Key 额度或协议回退。
- [ ] editor 展示模型覆盖：sub2api 无凭据字段、New API 只显示缺项、完整配置不回填、unsupported 无猜测表单。
- [ ] 导入 schema、单 hostname、精确名称消歧、重复歧义、无匹配、协议冲突与禁用记录。
- [ ] `missing` / `conflict` 生成写入，`complete` 不覆盖，阈值保留，sub2api 与 `apiCredentialProfiles` 永不生成写入。
- [ ] 配置摘要、预览、结果、错误和 controller state 不含假 `apiKey`、`accessToken` 或 `userId`。
- [ ] 阈值保存覆盖 New API 完整凭据保留、旧手工 sub2api 配置保留和无旧配置 sub2api 的无秘密存储。
- [ ] 现有低余额、今日消费、续航、stale evidence、编辑器互斥与可信点击回归通过。

执行并记录：

```powershell
node --check .\sub2-smart-group.user.js
node .\.tmp-balance-import.test.cjs
rg -n "apiCredentialProfiles|/api/usage/token/|console\.|GM_xmlhttpRequest|sub2ApiRequest|fetch\(" .\sub2-smart-group.user.js
rg -n "自动使用 sub2 已保存的 Key|手工兼容配置|余额查询模式" .\sub2-smart-group.user.js .\README.md .\.trellis\spec\frontend\manual-balance-monitoring.md
rg -n "@connect" .\sub2-smart-group.user.js
git diff --check
git status --short
```

本地敏感备份验证只输出计数：

- [ ] 重新确认 2026-07-29 备份的根 schema 与启用 New API 凭据完整率，不输出任何原始值。
- [ ] 在安装后的 `v2.7.1` 页面打开导入预览，证明计划使用全部当前账号而不是当前 36 个可见筛选子集；先取消并验证零写入。
- [ ] 用户确认后执行实际导入，只记录补充/纠正/已齐全/直接查询/歧义/无匹配/失败计数。
- [ ] 对一个已补充 New API 账号和一个 sub2api 账号分别由可信点击执行“查余额”，只记录成功/固定错误与协议类型，不记录凭据或原始响应。
- [ ] 删除临时测试文件并复查仓库无真实备份与疑似秘密。

## 7. Review, Commit, Live Validation, And Push

- [ ] Trellis implement review逐项核对 PRD acceptance criteria。
- [ ] Trellis check 完成 spec、语法、纯函数、UI 数据流、秘密泄漏、兼容与 diff 检查。
- [ ] 只暂存 userscript、README、余额 spec、账号编辑器 spec 和本任务记录；保留现有 Trellis/agent 无关改动。
- [ ] 提交并推送 `v2.7.1` 代码到 `origin/main`，再在已登录普通 sub2 页面更新脚本并执行第 6 节的全量预览、实际导入与两种查询验证。
- [ ] 只把脱敏计数与验证结论写入任务记录，归档任务、记录 journal，并提交/推送最终 Trellis 记录。
- [ ] 最终核对本地与远端 commit 一致，工作区只剩用户原有无关改动。

## Local Implementation Evidence (2026-07-29)

- Implemented the account-derived balance method resolver, New API
  account-balance-only routing, missing/conflict/complete import planning,
  hidden-credential threshold merge, editor changes, and `v2.7.1` docs/specs.
- A temporary Node assertion file used only explicit fake credentials. It
  covered resolver states, both request routes, threshold preservation,
  schema/matching/ambiguity/protocol rules, all import classifications,
  secret-free summaries, editor transitions, stale balance evidence, and exact
  registry / `@connect` parity. The assertions passed and the file was removed.
- `node --check sub2-smart-group.user.js`, Trellis task context validation,
  obsolete-endpoint/wording scans, and `git diff --check` passed locally.
- No real backup, browser write, upstream query, commit, push, archive, or live
  authenticated validation was performed in this implementation pass.
