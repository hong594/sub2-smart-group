# Sub2 & AIHub Smart Group

在 AIHub-Smart-Group 油猴脚本基础上改造：**完整保留 aihub.top 原有功能**，并新增一个面向
sub2api 后台的账号健康度可视化 + 路由管理面板。

## 核心原则：不主动测活

你的上游禁止测活。本脚本**不发送任何 test / probe / 测活类请求**。sub2 面板的所有数据都来自
sub2api 后台自身已有的接口，健康度只反映「真实流量触发的状态」：

- 账号列表的健康/冷却字段：`rate_limit_reset_at`、`overload_until`、
  `temp_unschedulable_until` / `temp_unschedulable_reason`、`schedulable`、`error_message`
- 今日真实用量：`today-stats/batch`（请求数 / 花费）

## 文件

| 文件 | 说明 |
|---|---|
| `sub2-smart-group.user.js` | **成品**，安装这个 |
| `aihub-original.user.js` | 原版备份，用于对照 / 回退 |

`sub2-smart-group.user.js` 里 aihub.top 的业务代码与原版**逐字节一致**（已用 diff 校验），
只有脚本头 `@match` 和入口 `start()` 增加了 sub2 分支。因此 aihub.top 上的行为与原版完全相同。

## 安装（推荐：一键装 + 自动更新）

1. 装 Tampermonkey。
2. 浏览器打开脚本 raw 地址，Tampermonkey 会自动弹出安装页，点「安装」：
   `https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js`
3. 打开 sub2api 后台（默认已匹配 `localhost:18080` / `localhost:8080` / `127.0.0.1`）。
4. **如果你用内网 IP、自定义域名或 HTTPS 访问后台**，在脚本头部按注释补一行 `@match`，例如：
   `// @match http://192.168.x.x:18080/*` 或 `// @match https://your-sub2-domain.com/*`

登录 sub2api 后台后，右下角出现蓝色圆钮，点开即面板。脚本复用页面里的登录态
（`localStorage.auth_token`），无需再次登录。

## 自动更新

脚本头已配置 `@updateURL` / `@downloadURL` 指向本仓库 raw 地址。仓库更新（且 `@version` 递增）后，
Tampermonkey 会自动检查并提示更新，无需重新粘贴。也可在 Tampermonkey → 实用工具 → 「检查用户脚本更新」手动触发。

## 面板功能

- **健康度总览**：正常 / 注意 / 已停用 / 不可用 四色统计。
- **账号列表**：每个账号显示健康色、优先级、今日请求数与花费、冷却倒计时、
  熔断/错误原因。可按健康度 / 优先级 / 今日花费 / 名称排序，可搜索。
- **随时手动调整路由**（均已验证不会清空 API Key）：
  - **摘出 / 挂回**：`POST /accounts/:id/schedulable`，立刻把账号踢出或加回调度池。
  - **恢复**：`POST /accounts/:id/recover-state`，清除限流/熔断冷却，强制拉回。
  - **优先级 ↑ / ↓**：`PUT /accounts/:id`（携带 `group_ids`），调分层路由。

默认每 30 秒刷新一次（只读列表 + 今日统计，不测活）。

## 安全边界

- 脚本只操作你已登录的 sub2api 后台，所有写操作都是 sub2 官方 admin API。
- 不读取、不外传 API Key（sub2 后台接口本身也不返回 Key 明文）。
- 不碰 sub2api 源码/镜像，官方更新时只需维护本脚本。

## 已验证

- `node --check` 语法通过。
- aihub.top 业务代码块 + AppRouter 类与原版逐字节一致。
- 健康度推断纯函数 5/5 用例通过（含限流、临时熔断、手动摘出、错误告警）。
- 排序：不可用账号排最前。
- 所有写接口在你的实例上做过 no-op 验证：API Key 不被清空。
