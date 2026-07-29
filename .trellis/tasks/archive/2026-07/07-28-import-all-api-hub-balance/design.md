# 余额查询方法判定与 All API Hub 补充技术设计

## Boundaries

改动限制在 userscript、README、Trellis 余额规范和任务记录：

- `sub2-smart-group.user.js` 负责本地方法判定、缺失字段界面、文件选择、备份解码、账号匹配、确认、GM 写入和脱敏结果。
- `README.md` 说明 sub2api / New API 的确定方法、缺失信息补充、导入边界和凭据安全约束。
- `.trellis/spec/frontend/manual-balance-monitoring.md` 记录方法解析、即时凭据读取和本地导入合同。
- `.trellis/spec/frontend/account-editors-and-audit.md` 将余额草稿从可选 mode/provider 改为账号派生方法，并保留互斥编辑器、草稿清理和焦点合同。
- 不修改 sub2 后端、数据库、容器、All API Hub 扩展或备份文件。

打开余额设置、渲染列表和导入预览都只能读取本地账号元数据与无秘密摘要。单账号导出及上游请求仍只允许从用户可信点击“查余额”或“保存并查询”开始。

## Method Resolver

新增纯函数，把协议判断、字段完整性和 UI 展示资格集中在一个边界：

```javascript
sub2BuildBalanceSetupState(account, storedConfigOrSummary)
  -> {
       method: 'sub2api-key' | 'newapi-account' | 'unsupported',
       providerType: 'sub2api' | 'newapi' | '',
       origin: string,
       requiredFields: string[],
       missingFields: string[],
       credentialState: 'direct' | 'complete' | 'missing' | 'conflict' | 'unsupported',
       queryAvailable: boolean,
       lowBalanceThreshold: number | null,
       message: string
     }
```

解析顺序固定：

1. 验证当前账号为正整数 ID 的 `apikey` 账号，并规范化其 HTTPS 标准端口上游地址。
2. 只从 `SUB2_BALANCE_PROTOCOL_BY_HOST` 读取精确 hostname 的协议；备份、旧配置和查询失败都不能改变协议。
3. `sub2api` 确定为 `sub2api-key`：origin 来自账号，Key 在可信查询点击后从 sub2 单账号导出，无需用户补充凭据。
4. `newapi` 确定为 `newapi-account`：origin 来自账号，只有与该 origin 绑定的完整 Access Token + 正整数 User ID 才使查询可用。
5. 未注册、协议为空、地址无效或协议冲突返回 `unsupported`，不显示来源猜测或凭据输入。

`sub2ResolveBalanceQuery()` 复用该状态：

- sub2api 始终构造单账号导出查询，旧手工 sub2api Key 不参与请求；可继续读取旧配置里的合法阈值。
- New API 只接受绑定当前 origin 的完整账号余额配置，并请求 `/api/status` + `/api/user/self`。
- New API 的 `/api/usage/token/` 模型 Key 额度退出实际查询解析链；缺凭据或查询失败都不回退。
- unsupported 状态不构造查询。

GM 中的 `mode: auto/manual` 标签继续作为旧数据解析细节存在，但不进入显示文案或用户选择控件。现有自动 New API 配置只有阈值而没有账号凭据，因此在新解析规则下显示为“需要补充”。

## Input Decoder

完整导入文件是敏感输入。它从 `File.text()` 进入局部变量，经纯解码/计划函数转为短生命周期写入计划；原始对象与含秘密计划不挂到 controller、DOM 或全局对象。

```javascript
sub2BuildAllApiHubBalanceImportPlan(rawBackup, accounts, existingConfigById)
  -> {
       writes: [{ accountId, config, reason: 'missing' | 'conflict' }],
       summary: {
         missing, conflict, complete, directSub2api,
         ambiguous, unmatched, skipped
       }
     }
```

`writes[].config` 是唯一含导入秘密的派生对象，只在导入处理函数局部存在。`summary` 只含计数，可进入确认与结果文案。函数只读取 `rawBackup.accounts.accounts`；`apiCredentialProfiles`、缓存余额、标签和其它字段全部忽略。

根对象或 `accounts.accounts` 不是预期对象/数组时返回固定 schema 错误，不生成部分计划。单个候选项必须满足：

- `disabled` 明确为 `false`；
- `site_url` 是无凭据、无查询、无片段、HTTPS 标准端口 URL；
- `site_type` 是 `new-api` 或 `sub2api`；
- `site_name` 是非空字符串；
- New API 的 `account_info` 是普通对象，`access_token` 非空且无 CR/LF，`id` 是安全正整数或正整数字符串。

无效单项计入 `skipped`，但不使其它合法项失效。只有根 schema 错误才使整次导入零计划。

## Matching Contract

导入必须使用 controller 的完整 `this.accounts`，不受当前筛选、排序、分组视图或只渲染部分账号影响。每个当前账号独立匹配：

1. 要求当前账号满足 Method Resolver 的基础账号与地址校验。
2. 从启用且结构有效的备份项中选择相同规范化 hostname 的候选。
3. 候选为 0 时计入 `unmatched`；候选为 1 时唯一对应。
4. 候选大于 1 时，仅保留 `trim(site_name) === trim(account.name)` 的项；结果恰好为 1 才唯一对应，否则计入 `ambiguous`。
5. 对应项的 `site_type` 必须与注册表协议一致；冲突计入 `skipped`。

匹配不使用路径前缀、用户名、更新时间、余额、数组顺序或模糊名称。重复同 hostname / 同名称候选稳定落入 `ambiguous`。

## Existing Configuration Classification

### New API

对唯一匹配账号先分类已有设置：

- 完整的 New API 配置、origin 等于当前账号 origin、Access Token 和 User ID 均有效：计入 `complete`，不生成写入，不覆盖。
- 没有有效账号余额配置：生成 `reason: missing` 写入。
- 旧配置的 provider、origin 或内部模式与当前 New API 账号余额方法冲突：生成 `reason: conflict` 写入，并在预览中单独计数。

写入格式保持旧版兼容：

```javascript
{
  mode: 'manual',
  type: 'newapi',
  baseUrl: normalizedOrigin,
  accessToken,
  userId: String(positiveId),
  lowBalanceThreshold: existingThreshold ?? null,
}
```

每项仍经过 `sub2ParseBalanceConfig()` 和 `sub2SaveBalanceConfig()`；只有用户确认后才补充/纠正。若完整凭据需要更换，用户先明确清除该账号设置，再重新输入或导入。

### sub2api

对应项计入 `directSub2api`，不产生写入，也不读取备份 Access Token。查询时由现有单账号导出链取得当前 sub2 所保存的模型 Key，再请求 `/v1/usage`。

旧手工 sub2api 配置不参与新查询，也不由升级或导入物理删除。其合法阈值仍可沿用；只有用户明确点击清除设置时才删除 GM 值。

## Secret-Free Controller State

`balanceConfigsById` 继续只保存无秘密摘要。摘要可增加方法与完整性所需的布尔信息，但不得包含 `apiKey`、`accessToken` 或 `userId`：

```javascript
sub2BuildBalanceConfigSummary(config)
  -> { mode, type?, baseUrl?, lowBalanceThreshold, hasStoredCredentials? }
```

- 启动/刷新读取 GM 配置后，只把摘要放入 controller，立即释放完整配置引用。
- 保存或导入后也只更新摘要。
- Method Resolver、渲染和按钮资格只读取账号元数据与摘要。
- 用户点击 New API 查询或保存时，局部重新读取完整 GM 配置；`finally` 清空复制字段并释放引用。
- 用户点击 sub2api 查询时，完整导出对象与 Key 仅存在于该次查询局部；旧 GM 凭据不读取进请求链。
- 只保存阈值时局部加载现有完整配置并只替换阈值：New API 保留 Access Token / User ID，旧手工 sub2api 配置也原样保留其 Key；没有旧配置的 sub2api 才写入无秘密的内部 auto + threshold 配置。

## Per-Account UI Flow

余额编辑器不再显示“自动 / 手工模式”、来源类型选择器或可编辑 origin：

1. 标题区域显示已确定的方法与规范化站点，例如“New API 账号余额”或“sub2api 模型 Key 余额”。
2. sub2api 显示“可直接使用 sub2 已保存的 Key”，只提供可选低余额阈值和保存/查询动作。
3. New API 完整配置显示“信息已齐全”，不把凭据回填或再次渲染输入框；保留阈值、查询与明确清除设置动作。
4. New API 缺失配置只显示缺少的 Access Token / User ID 输入，以及保存、保存并查询、取消动作。
5. 冲突旧配置显示固定脱敏提示，要求补充当前方法所需字段；保存后以确认的新配置替换冲突值。
6. unsupported 只显示无法确定方法的原因，不显示凭据输入或保存并查询。

正整数 ID 的 apikey 账号始终保留“余额设置”入口；unsupported 状态的查询按钮不可执行，但用户仍可从设置入口查看固定原因。不得因为 resolver 无查询计划而让原因界面不可达。

余额草稿中的 method/provider/origin 来自账号解析并且不可由 UI 改写；只有阈值与当前 New API 缺失凭据属于可编辑草稿。切换账号、过滤隐藏、取消或能力变化仍清空所有未保存秘密并保持现有互斥编辑器与焦点恢复合同。

打开编辑器只做本地解析。清除设置继续要求用户确认；清除 New API 设置后状态变为需要补充，清除 sub2api 旧设置后仍可直接使用当前 sub2 Key。只保存阈值通过局部 GM 合并边界保留所有隐藏的已有凭据，不以重建可见表单对象的方式覆盖存储。

## Import UI Flow

搜索栏保留“导入余额”按钮和隐藏 JSON 文件输入：

1. 可信按钮点击且当前无导入时打开文件选择器。
2. 文件选择后禁用按钮，局部读取并解析 JSON。
3. 使用完整账号列表构造计划，仅把 `summary` 格式化进确认框。预览显示将补充、将纠正、已齐全、可直接查询、歧义、无匹配和其它跳过数量。
4. 取消时零 GM 写入。
5. 确认后逐项调用现有保存边界；成功项更新无秘密摘要并清除旧余额结果，失败项保留原 GM 值与摘要。
6. 重绘列表并显示脱敏成功/失败计数；不自动查询余额。
7. `finally` 清空文件 input、原始文本、解析对象和写入计划引用，恢复按钮。

## Error And Partial-Write Policy

- JSON 解析、根 schema 和文件读取错误使用固定脱敏文案，不拼接原始异常、文件内容或候选字段。
- 根失败和用户取消保证零写入。
- GM 存储没有事务。确认后按账号独立写入；某项失败时继续其它项，失败账号保留原值。
- 结果不列账号名、hostname、ID 或失败详情。
- 不自动重试、不探测、不查询余额、不切换协议或查询语义。

## Compatibility And Rollback

- GM key 和 New API 完整配置 schema 不变，无批量迁移或自动删除。
- 旧手工 New API 配置只要绑定当前 origin 且字段完整，直接视为已齐全。
- 旧 sub2api 手工凭据保留但不参与查询；旧 New API 自动配置保留阈值但需要补充账号凭据。
- 账号编辑器规范与余额规范同步切换到账号派生方法；容量、日配额和编辑器互斥状态合同不变。
- 已导入配置仍能被旧版 userscript 读取；回滚脚本会恢复旧解析行为。
- `/api/usage/token/` 相关 helper 若已无消费者可在实现中删除；删除前必须以静态调用扫描证明无其它功能依赖。
- 版本保持 `2.7.1`；注册表和 `@connect` 不因备份内容扩张。

## Security Review Points

- 真实备份路径、内容、账号名、hostname、Token、User ID 和原始响应不得写入仓库。
- 测试固定使用假 Token / ID，并断言它们不出现在 summary、错误、controller 摘要或渲染文本。
- 静态检查设置打开与导入函数没有单账号导出、`fetch`、`sub2ApiRequest`、`GM_xmlhttpRequest`、日志或剪贴板调用。
- 静态检查 `apiCredentialProfiles` 与 sub2api `account_info.access_token` 没有读取到写入或请求路径。
- 静态检查 New API 查询解析不再到达 `/api/usage/token/`，且失败路径没有协议或凭据回退。
