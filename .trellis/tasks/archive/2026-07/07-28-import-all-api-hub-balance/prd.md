# 导入 All API Hub 余额设置

## Goal

让用户在 userscript 面板中选择现有 All API Hub 备份 JSON，脚本在本地把能够唯一对应到当前 sub2 账号的余额查询资料写入 Tampermonkey 私密存储。导入后，用户直接点击账号的“查余额”即可查询，不需要逐个抄写 Access Token 和 User ID。

余额设置本身先根据当前账号确定可用的查询接口和必需信息，再复用 sub2、已存设置或备份中已有的数据，只让用户补充仍然缺失的字段。

## Confirmed Facts

- 当前余额设置按“当前 sub2 origin + 账号 ID”存入 Tampermonkey，New API 的既有兼容合同是 `Access Token + User ID -> GET /api/user/self`；`sub2SaveBalanceConfig()` 已负责规范化和持久化。
- 当前 v2.7 查询链已经能为注册表中的 sub2api 账号临时读取 sub2 所保存的模型 API Key，并请求 `/v1/usage`。All API Hub 的 sub2api `account_info.access_token` 不是该接口所需的 API Key，实测会返回 HTTP 401，因此不得导入。
- New API 的 `account_info.access_token` 与正整数 `account_info.id` 可用于 `/api/user/self`；已在一个注册站点验证成功并返回 quota 数据。
- 2026-07-29 备份有 129 条记录，其中 121 条启用：85 条 New API、31 条 sub2api、1 条 anyrouter 和 4 条 unknown。85 条启用 New API 均具备非空单行 Access Token 和正整数 User ID，可满足 `/api/user/self` 的凭据要求。
- 31 条启用 sub2api 记录中的 `account_info.access_token` 仍是站点登录令牌，不是 `/v1/usage` 所需模型 API Key；`sub2apiAuth` 也没有可绑定到当前账号的模型 Key。备份中的 12 个 `apiCredentialProfiles` 均属于 New API 或未注册站点，不能替代当前 sub2 单账号导出的 Key。
- 当前 Chrome 中 `v2.7.0` 页面显示共 69 个账号，但已有筛选只渲染其中 36 个。在这个不改筛选状态的可见子集中，23 个唯一匹配的 New API 账号具备完整账号余额凭据、8 个匹配 sub2api、1 个歧义、4 个无匹配；这只是子集证据，不得外推成 69 个账号的全量导入计数。
- 备份根结构为 `accounts.accounts[]`。候选项包含 `site_name`、`site_url`、`site_type`、`disabled` 和 `account_info`；真实备份、令牌和用户 ID 不进入仓库。
- 当前协议注册表是余额目的地和协议类型的运行时权威。备份只提供账号级余额资料，不能扩大 `@connect` 或协议白名单。

## Requirements

### Method-First Balance Setup

- 余额设置必须先根据当前 sub2 账号的类型、规范化上游地址和已确认协议，确定可用的余额查询接口及其必需信息；不得先要求用户选择“自动 / 手工模式”或重复选择已经能够确定的来源类型。
- 设置界面应明确显示已确定的查询方法、已有信息和缺失信息，只为缺失的必需字段提供补充入口；低余额阈值仍是与查询凭据无关的可选设置。
- `sub2api /v1/usage` 需要规范化上游 origin 和模型 API Key。origin 来自当前账号，API Key 只在用户点击查询后从 sub2 单账号导出，因此这条路径不要求用户再次录入或从备份导入凭据。
- New API 固定查询站点账号余额：先读取公开 `/api/status` 的动态 `quota_per_unit`，再用 Access Token + 正整数 User ID 请求 `/api/user/self`。现有 `/api/usage/token/` 模型 Key 额度不是账号余额，本次不作为默认、备用或失败回退路径。
- New API 的规范化 origin 和协议由当前账号与注册表确定；若所需 Access Token / User ID 已存储或能从唯一匹配的 All API Hub 记录取得，则直接复用或导入，只向用户索取仍缺失的字段。
- 未注册、协议为空或协议冲突的站点显示为无法确定查询方法，不显示可猜测的来源或凭据表单，也不探测上游。
- 打开余额设置只做本地能力与字段完整性判断，不导出 Key、不探测上游、不发起余额请求。任何凭据导出和上游查询仍必须来自用户明确点击“查余额”或“保存并查询”。

### Existing Settings And Missing Fields

- 内部 `mode` 标签继续用于读取旧 GM 配置和回滚兼容，但不再作为用户可选概念显示在界面中。
- 同一账号已有与当前 New API origin 绑定且字段完整的 Access Token + User ID 时，状态为“信息已齐全”；普通导入不得覆盖这组凭据。
- 没有有效 New API 账号余额配置，或旧配置的来源、协议、origin 与当前确定方法冲突时，状态为“需要补充”。唯一匹配的备份记录可在用户确认后写入正确配置，并保留合法低余额阈值。
- sub2api 始终走当前 sub2 单账号导出的模型 Key。旧手工 sub2api 凭据不再参与查询，但保持原 GM 数据不被自动删除；仅用户明确清除设置时删除。
- 单账号设置只展示当前确定方法真正缺失的凭据字段。完整凭据不回填 DOM；如需更换，用户先明确清除旧设置，再重新补充或导入。
- 只修改低余额阈值时必须局部读取并保留该账号已有完整配置；不得因为界面隐藏凭据字段而把旧 New API 或 sub2api 凭据顺带清空。

### Local Import Trigger

- 在面板搜索栏的“刷新”旁增加“导入余额”命令，点击后选择本地 `.json` 文件。
- 文件只由该次用户操作在浏览器内存中读取和解析，不上传、不调用扩展页面、不写日志、不写网页 `localStorage`。
- 导入进行中禁止重复触发；完成、取消或失败后清空文件输入和所有原始数据局部引用。

### Validation And Matching

- 根对象、`accounts.accounts` 数组和候选项字段必须按未知输入严格校验；结构错误时不得写入任何账号。
- 只考虑 `disabled === false`、HTTPS 标准端口、地址可规范化、账号资料完整的备份项。
- 当前 sub2 账号必须有正整数 ID、`type=apikey`、可规范化的已注册 hostname。
- 首先按规范化 hostname 匹配。一个 hostname 只有一个有效候选时直接对应；有多个候选时，只有当前账号名与 `site_name` 精确 trim 后匹配出唯一一项才可对应。
- 多候选仍不唯一、没有候选、协议冲突、禁用、字段缺失或凭据无效时必须跳过，不得按数组顺序、更新时间、用户名、余额或模糊名称猜测。

### Write Contract

- 唯一对应、注册表协议为 New API 且状态为缺失或冲突的账号，写入现有余额配置：规范化 origin、Access Token、正整数 User ID，并保留该账号已有的低余额阈值。
- 候选项必须同时声明 `site_type=new-api`；备份协议与注册表不一致时跳过。
- sub2api 候选项不写入备份 Access Token；只在结果中计为“无需导入，可直接查询”，继续走 v2.7 现有单账号 Key 查询链。
- 已有且与当前 New API 方法绑定正确、字段完整的设置计为“信息已齐全”并跳过，不覆盖。缺失或冲突的旧设置可在确认后补齐/纠正，预览必须分别显示将补充、将纠正和已齐全数量。
- 每个写入仍通过现有配置解析与 GM 存储边界。单项写入失败时保留该账号原设置，继续处理其它已确认项，并只报告脱敏计数。

### Preview, Result, And Secret Handling

- 写入前显示脱敏预览：将补充、将纠正、已齐全、无需导入、歧义、无匹配和其它跳过数量；用户取消时零写入。
- 写入后显示脱敏结果：成功、失败、无需导入及跳过数量。不得显示账号资料、文件内容、Token、User ID 或原始异常/响应。
- 原始备份、Access Token、User ID 和响应不得进入 DOM 文本、控制器持久状态、诊断、日志、剪贴板、测试夹具或 Git。
- 控制器中的余额配置缓存只保留无秘密摘要；完整已存凭据仅在保存边界或用户点击查询时局部读取，并及时释放引用。
- 测试只能使用明显虚构的令牌和 ID；错误与摘要必须由固定文案和计数构造。

### Compatibility

- 保持 GM 存储 key、New API `Access Token + User ID` 配置格式、低余额阈值、今日消费和续航展示合同；旧配置可读取但由新方法解析规则决定是否参与查询。
- 不自动发起余额查询。导入只填充设置，余额网络请求仍只由用户点击单账号“查余额”触发。
- 不根据查询失败切换协议或退回 New API 模型 Key 额度，不为未知 hostname 猜测协议，不导入只存在于 `apiCredentialProfiles` 的过期或非当前站点 Key。
- README、userscript 版本、余额规范和账号编辑器规范要与最终行为一致；本次作为 v2.7 的补丁版本发布。

## Acceptance Criteria

- [ ] 打开单账号余额设置时，界面先展示脚本根据账号得出的查询方法及信息完整性，不再显示“自动 / 手工模式”和可由脚本确定的来源类型选择器。
- [ ] sub2api 账号显示可直接使用 sub2 已保存的模型 Key 查询，除可选低余额阈值外不要求补充凭据。
- [ ] New API 固定显示并查询站点账号余额；已有完整且绑定正确的 Access Token + User ID 时显示“信息已齐全”，否则只显示缺少的输入项，不自动或失败后切换到模型 Key 额度。
- [ ] 未知、未注册、协议为空或协议冲突的账号显示无法确定查询方法，不展示可猜测的来源/凭据选择器。
- [ ] 打开设置和导入预览不触发单账号导出或上游请求，实际查询仍只由可信用户点击触发。
- [ ] 用户可从面板选择 2026-07-29 All API Hub 备份，确认脱敏预览后一次填入所有可唯一对应的 New API 余额设置。
- [ ] 正式导入前必须以当时页面中的完整当前账号列表重新计算全量计划；旧 67 账号快照和当前 36 账号可见子集的计数都不得作为 69 个账号的固定验收结果，实际覆盖数按运行时已有设置计算。
- [ ] 同 hostname 的重复启用候选不会被猜选；禁用、格式错误、协议冲突、无匹配及凭据无效项均不会写入。
- [ ] New API 写入使用规范化 origin、非空无换行 Access Token 和正整数 User ID，并保留已有低余额阈值。
- [ ] 已有完整且绑定正确的 New API 设置不会被普通导入覆盖；缺失与冲突设置分别计数，并且只有用户确认后才补充或纠正。
- [ ] 只保存阈值会保留完整已有配置；旧 sub2api 凭据虽然不参与查询，也不会因阈值编辑或升级被隐式删除。
- [ ] 任意 sub2api `account_info.access_token` 和备份 `apiCredentialProfiles` Key 均不会被导入；已识别的 sub2api 账号仍能走现有 sub2 Key 查询链。
- [ ] 预览取消或备份 schema 无效时零写入；确认后逐项写入并给出不含秘密的成功/失败摘要。
- [ ] 导入后的账号无需再次填写资料即可点击“查余额”；导入本身不触发上游余额请求。
- [ ] 真实备份、Token、User ID、账号原始响应和疑似秘密未进入 DOM 文本、控制器状态、日志、测试文件、文档或 Git。
- [ ] 脱敏 Node 断言覆盖 schema、匹配、歧义、跳过、阈值保留、完整/缺失/冲突分类、sub2api 禁止导入和摘要泄漏；`node --check`、注册表 / `@connect` parity 与 `git diff --check` 通过。
- [ ] README、`.trellis/spec/frontend/manual-balance-monitoring.md` 和 `.trellis/spec/frontend/account-editors-and-audit.md` 已更新，版本提升为 `2.7.1`，只提交本任务文件并推送到 `origin/main`。

## Out Of Scope

- 自动或批量执行余额网络查询。
- 操作 `chrome-extension://` 页面、直接修改 All API Hub 扩展数据或改写备份文件。
- 导入/创建 sub2 账号、修改账号路由、健康、调度、分组或模型配置。
- 修改 sub2 后端、数据库、容器或上游站点。
- 为未知或冲突站点做探测、模糊匹配、协议猜测或失败回退。
- 为 New API 暴露模型 Key 额度切换、自动回退或双余额并列展示。
- 从备份恢复缓存余额、收入、标签、书签、偏好或其它非余额查询资料。
