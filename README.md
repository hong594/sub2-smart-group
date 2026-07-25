# Sub2 & AIHub Smart Group

在 AIHub-Smart-Group 油猴脚本基础上改造：**完整保留 aihub.top 原有功能**，并新增一个面向
sub2api 后台的账号健康度可视化 + 路由管理面板。

## 核心原则：不主动测活、不自动请求上游

你的上游禁止测活。本脚本**不发送任何 test / probe / 测活类请求**。sub2 面板的所有数据都来自
sub2api 后台自身已有的接口，健康度只反映「真实流量触发的状态」：

- 账号列表的健康/冷却字段：`rate_limit_reset_at`、`overload_until`、
  `temp_unschedulable_until` / `temp_unschedulable_reason`、`schedulable`、`error_message`
- 今日真实用量：`today-stats/batch`（请求数 / 花费）

账号卡片中的“模型”功能默认只读取 sub2 已保存的模型列表，不访问上游。只有用户明确点击
“拉取并同步上游”时，脚本才调用 sub2 官方模型同步接口访问一次对应上游；脚本不会自动或定时执行。

## 文件

| 文件 | 说明 |
|---|---|
| `sub2-smart-group.user.js` | **成品**，安装这个 |
| `aihub-original.user.js` | 原版备份，用于对照 / 回退 |

`sub2-smart-group.user.js` 里 aihub.top 的业务代码与 `AppRouter` 保持原版不变；脚本元数据和
入口 `start()` 增加了 sub2 分支。因此 aihub.top 上的行为与原版相同。

## 安装（推荐：一键装 + 自动更新）

1. 装 Tampermonkey。
2. 浏览器打开脚本 raw 地址，Tampermonkey 会自动弹出安装页，点「安装」：
   `https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js`
3. 打开 sub2api 后台（默认已匹配 `localhost:18080` / `localhost:8080` / `127.0.0.1`）。
4. **如果你用内网 IP、自定义域名或 HTTPS 访问后台**，进入 Tampermonkey → 本脚本 → 设置，
   在“用户匹配”中添加地址，例如 `http://192.168.x.x:18080/*` 或
   `https://your-sub2-domain.com/*`。用户匹配不会被脚本自动更新覆盖。

登录 sub2api 后台后，右下角出现蓝色圆钮，点开即面板。脚本复用页面里的登录态
（`localStorage.auth_token`），无需再次登录。

## 自动更新

脚本头已配置 `@updateURL` / `@downloadURL` 指向本仓库 raw 地址。仓库更新（且 `@version` 递增）后，
Tampermonkey 会自动检查并提示更新，无需重新粘贴。也可在 Tampermonkey → 实用工具 → 「检查用户脚本更新」手动触发。

## 面板功能

- **当前版本**：`v1.5.0`，版本号会显示在面板标题和底部状态栏。
- **横向紧凑布局**：桌面端面板约 860px 宽、高度约为视口的 62%，账号卡片采用双列布局；
  窄屏自动回退为单列，减少对 sub2 主页面的遮挡。
- **健康度总览**：正常 / 注意 / 已停用 / 不可用 四色统计。
- **按分组分类**：默认按 sub2 分组展示账号；多分组账号会出现在对应的每个分组下，
  未加入任何分组的账号归入“未分组”。每个分组显示账号数，以及不可用、注意和停用状态计数。
- **账号列表**：每个账号显示健康色、账号优先级、组内优先级、今日请求数与花费、
  冷却倒计时、熔断/错误原因。可切换“按分组 / 全部账号”，并按健康度 / 优先级 /
  今日花费 / 名称排序，也可按账号名、平台或分组名搜索。
- **随时手动调整路由**（只调用 sub2 官方 admin API，不读取或提交 API Key）：
  - **摘出 / 挂回**：`POST /accounts/:id/schedulable`，立刻把账号踢出或加回调度池。
  - **恢复**：`POST /accounts/:id/recover-state`，清除限流/熔断冷却，强制拉回。
  - **账号优先级 ↑ / ↓**：`PUT /accounts/:id` 只提交账号级 `priority`，调分层路由；
    不提交 `group_ids`，因此不会重建分组关联或改写组内优先级。组内优先级会展示并参与分组内排序。
- **账号模型**：
  - 点击“模型”只调用 `GET /accounts/:id/models` 查看 sub2 已保存的模型，可在抽屉中搜索。
  - 点击“拉取并同步上游”才调用 `POST /accounts/:id/models/sync-upstream`；该操作会真实访问上游，
    并由 sub2 更新账号保存的模型配置，按钮和界面中均有明确提示。

默认每 30 秒刷新一次（只读列表 + 今日统计，不测活）。

## 安全边界

- 脚本只操作你已登录的 sub2api 后台，所有写操作都是 sub2 官方 admin API。
- 不读取、不外传 API Key（sub2 后台接口本身也不返回 Key 明文）。
- 不提供所谓“通用上游余额查询”：第三方 `key/base_url` 没有统一余额协议，sub2 的
  `upstream-billing-probe` 是计费倍率探测而不是余额查询，避免将不同概念混在一起。
- 不碰 sub2api 源码/镜像，官方更新时只需维护本脚本。

## 已验证

- `node --check` 语法通过。
- aihub.top 业务代码块 + `AppRouter` 类保持原版不变。
- 健康度推断纯函数 5/5 用例通过（含限流、临时熔断、手动摘出、错误告警）。
- 排序：不可用账号排最前。
- 调整账号优先级只提交 `priority` 字段，不提交 credentials 或 `group_ids`。
