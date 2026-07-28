# 补全余额查询功能

## Goal

让已有 sub2 `apikey` 账号在用户点击“查余额”时，直接临时使用 sub2 已保存的 API Key 查询上游余额，不再要求为同一账号重复录入 Key；同时保留旧手工余额配置的兼容路径，并维持现有的低余额提醒、今日消费和续航估算能力。

## Confirmed Facts

- 当前实现只支持手工配置 `sub2api` 与 `newapi`，余额凭据按“当前 sub2 地址 + 账号 ID”保存在 Tampermonkey；New API 仍使用 `Access Token + User ID -> /api/user/self` 并硬编码除以 `500000`。
- 当前 sub2 部署为 `v0.1.166`。管理员只读导出接口 `GET /api/v1/admin/accounts/data` 支持 `ids=<account-id>` 和 `include_proxies=false`，会返回账号原始 `credentials`。
- 导出的 `DataAccount` 不包含账号 ID。因此响应绑定不能依赖响应 ID，只能依赖请求 URL 中的单个 ID、恰好一条账号响应，以及当前行与导出项的名称、平台、类型和规范化 `base_url` 复核。
- 当前 35 个账号涉及 29 个唯一域名：其中 23 个已确认是 New API，5 个已确认是 sub2api，`kuai.dmxcode.com` 尚无可靠协议证据。
- New API 的模型 Key 查询合同为 `GET /api/usage/token/`；返回额度是内部 quota。公开 `GET /api/status` 会返回站点自己的正数 `quota_per_unit`，金额必须按该值动态换算成 USD。
- All API Hub 备份只用于辅助核对域名和协议，不作为本功能的凭据、余额快照或账号数据来源。

## Requirements

### Trusted Trigger

- 单账号导出和随后的外部查询必须由同一次可信“查余额”点击触发。
- 启动、刷新、筛选、排序、列表重建、轮询、定时器和可见性事件不得导出凭据或访问外部余额接口。
- 每次点击最多导出当前一个账号；不得批量导出、自动重试、测活或根据失败猜测另一种协议。

### Account Binding And Secret Handling

- 自动查询只支持已确认协议且类型为 `apikey` 的当前 sub2 账号。
- 使用 `GET /api/v1/admin/accounts/data?ids=<current-id>&include_proxies=false` 获取单账号导出；响应必须恰好包含一条账号，且名称、平台、类型和规范化 `credentials.base_url` 均与当前行一致。
- 导出响应没有账号 ID 是已知限制。请求中的单个 ID、单条响应约束和元数据复核共同构成绑定条件；任一条件不满足都必须在读取或发送 Key 前拒绝。
- API Key 只存在于当前查询的局部引用中，不得进入 GM 存储、DOM、`localStorage`、日志、错误文本、诊断、剪贴板、文件、测试夹具或 Git；查询结束后在 `finally` 中清空变量并丢弃导出对象引用。
- 不承诺 JavaScript 无法保证的物理内存清零；可验收边界是无持久化、无可见泄漏、无跨查询复用并及时释放引用。

### Protocol And Destination

- sub2api 固定请求 `GET <exported-origin>/v1/usage`，使用 `Authorization: Bearer <exported-api-key>`，继续采用现有严格余额字段和单位解析。
- New API 必须先匿名请求 `GET <exported-origin>/api/status`，验证成功对象和正数 `quota_per_unit`；只有验证通过后，才使用导出的模型 Key 请求 `GET <exported-origin>/api/usage/token/`。
- New API 读取 `total_available`、`total_used`、`total_granted`、`unlimited_quota` 和 `expires_at`；有限额度按站点返回的 `quota_per_unit` 动态除算并统一为 USD，禁止保留硬编码 `500000`。
- 请求目标只能由导出账号自己的 `credentials.base_url` 推导，且必须是精确白名单内的 HTTPS 标准端口；路径由协议注册表固定，拒绝重定向且不携带第三方 Cookie。
- 29 个当前域名使用精确 `@connect` 和同源代码注册表，不使用通配符；两个过期项 `sub.100xlabs.space`、`new.ambition.qz.io` 移除。
- `kuai.dmxcode.com` 不启用自动协议；只有用户已明确保存的旧手工配置才可按原合同查询，不得自动猜测。

### Configuration And Compatibility

- 已确认协议且没有旧手工配置的 `apikey` 账号默认使用“sub2 已保存 Key”自动模式，直接显示“查余额”。
- 自动模式的余额设置只持久化模式和低余额阈值，不持久化导出的 Key、导出地址或协议副本。
- 旧 `sub2api` API Key 配置和旧 New API `Access Token + User ID` 配置继续作为手工兼容模式读取和执行；已有配置不静默删除或改写。
- 用户显式把旧手工配置切换为自动模式并保存时，新配置不再保留旧手工秘密。
- 自动查询失败后只显示本次错误，不自动改走旧手工凭据；手工模式必须由现有配置或用户显式选择决定。

### Result And Evidence

- 成功结果显示协议、余额或“无限额度”、币种和查询时间；可用时继续显示已用额度、今日消费与套餐信息。
- New API `unlimited_quota=true` 时不得把 `total_available` 当作有限余额，不触发低余额告警，也不计算续航。
- 失败不得覆盖上一次成功的余额证据；错误必须可操作但不得包含 Key、原始响应或其它秘密。
- 现有今日统计新鲜度、USD 续航条件、编辑器互斥、刷新暂停和列表重建行为保持兼容。

## Acceptance Criteria

- [x] 已确认协议的现有 `apikey` 账号无需重复填写 Key；一次可信点击只导出当前账号，并完成对应协议的实时余额查询。
- [x] 单账号导出响应只有通过单条约束及名称、平台、类型、规范化地址复核后才会读取和发送 Key；不一致、缺字段和多条响应均拒绝。
- [x] sub2api 查询只访问固定 `/v1/usage`；New API 查询严格按 `/api/status` 后 `/api/usage/token/` 的顺序执行，并使用响应中的 `quota_per_unit` 换算 USD。
- [x] New API 无限额度显示明确，不触发低余额状态或续航估算；有限额度的余额、已用和总额均为严格有限数字。
- [x] 启动、自动刷新、筛选、排序、轮询、定时器和列表重建不会导出账号或发起外部余额请求。
- [x] 导出 Key 不进入持久化存储、DOM、日志、错误、诊断、剪贴板、文件或测试数据，且不会发送到导出账号之外的目标。
- [x] 旧手工 `sub2api` 与 New API 配置继续可用；自动模式只保存模式和阈值，自动失败不触发隐式手工回退或重试。
- [x] 精确 `@connect` 与 29 个当前域名保持一致，移除两个过期项且没有通配符；未知协议域名不自动查询。
- [x] 脱敏 Node 断言覆盖导出绑定、协议注册表、动态 quota 换算、无限额度、配置兼容、目标限制和可信点击调用路径；现有余额与编辑器回归保持通过。
- [x] README 和 Trellis 余额规范与最终实现一致，不包含任何真实 Key、Token、Cookie 或备份秘密。

## Out Of Scope

- 从 All API Hub 导入账号、凭据或缓存余额，或展示只存在于备份中的账号。
- 为未知域名自动探测、猜测协议或增加“通用余额解析器”。
- 修改 sub2 后端、镜像、容器、数据库或导出接口。
- 批量余额查询、批量凭据导出、自动重试、主动模型请求、测活或自动摘出/挂回账号。
- 对 JavaScript 运行时作物理内存清零保证。
