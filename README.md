# Sub2 Smart Group

面向个人 sub2api 后台的 Tampermonkey 管理工具。它在不修改 sub2api 源码、前端文件或容器镜像的前提下，提供账号健康状态、真实路由记录、优先级、日配额和模型管理能力。

从 `v2.0.0` 开始，项目已经移除全部 AIHub 页面匹配和业务代码，成为纯 sub2 专属工具。原有 `sub2-smart-group:` 存储键、GitHub Raw 更新地址和 userscript namespace 保持不变，升级后已有面板偏好不会因此丢失。

## 核心原则：不主动测活

上游禁止测活时，本脚本不会定时调用 test / probe，也不会为了判断健康状态发送模型请求。自动刷新只读取当前 sub2 后台的本机 Admin API：

- 账号健康和冷却状态；
- 分组与平台配置；
- 今日真实请求数和花费；
- 最近成功请求和真实故障转移记录。

账号卡片中的“模型”按钮默认只读取 sub2 已保存的模型。只有用户明确点击“拉取并同步上游”时，才会通过 sub2 官方接口访问对应上游。

## 安装与自动更新

1. 安装 Tampermonkey。
2. 打开以下 GitHub Raw 地址并安装：
   `https://raw.githubusercontent.com/hong594/sub2-smart-group/main/sub2-smart-group.user.js`
3. 登录 sub2api 后台，右下角会出现蓝色 `S2` 按钮。

脚本默认匹配：

```text
http://localhost:18080/*
http://127.0.0.1:18080/*
http://localhost:8080/*
http://127.0.0.1:8080/*
```

如果使用内网 IP、自定义域名或 HTTPS，请在 Tampermonkey 的本脚本设置中添加“用户匹配”，例如：

```text
http://192.168.x.x:18080/*
https://your-sub2-domain.com/*
```

脚本保留了 GitHub Raw `@updateURL` 和 `@downloadURL`。自动检查频率由 Tampermonkey 自身控制，也可手动执行“检查用户脚本更新”。

## 当前版本

`v2.0.0`

本版本移除了：

- `aihub.top` 页面匹配；
- AIHub 智能分组、自动切组和监控逻辑；
- AIHub 余额、倍率、Key 分组增强逻辑；
- `unsafeWindow` 权限；
- 仓库中的 AIHub 原版备份文件。

## 面板功能

### 账号状态与筛选

- 正常、注意、不可用、已停用四色健康总览；
- 按分组或全部账号展示；
- 按分组、平台和健康状态筛选；
- 按健康度、优先级、今日花费或名称排序；
- 搜索账号名称、平台和分组；
- 五个筛选项采用紧凑单行布局。

### 最近命中与路由原因

- 最近一次成功请求实际使用的账号显示“最近命中”；
- 优先读取 `/admin/ops/requests`，运维接口不可用时才回退到 `last_used_at`；
- 展示真实的 401、403、429、502、503 等上游故障转移记录；
- 优先通过客户端请求 ID 关联失败账号和最终成功账号；
- 明确区分“已证实”“当前状态 / 配置判断”和“推测”；
- 对没有完整候选淘汰轨迹的情况，不会武断声称某账号一定没有被请求。

### 账号路由管理

- 紫色 `P数字` 标签突出账号优先级；
- 手动提升或降低账号优先级；
- 摘出或挂回调度池；
- 清除限流、过载或临时熔断冷却；
- 只读展示池模式，不提供容易误用的快捷切换；
- 显示组内优先级和账号所属分组。

### 日配额

API Key / Bedrock 账号支持：

- 查看当日已用金额和每日美元限额；
- 使用率达到 80% 或 100% 时显示警告色；
- 手动设置或取消每日限额；
- 保存前读取账号最新详情，完整保留其它 `extra` 字段；
- 取消限制时只清理日配额相关字段。

### 模型与上游链接

- 查看 sub2 已保存的账号模型并搜索；
- 只有明确点击后才拉取并同步上游模型；
- 账号名称可打开 `base_url` 对应的站点根地址；
- 只有名称文字和外链图标可以点击，标题栏空白处不会误触；
- 链接只允许 HTTP / HTTPS，并使用 `noopener noreferrer`。

### 布局与刷新

- 约 430px 宽的竖向单列面板；
- 桌面端高度约为视口的 80%，最高 820px，通常可完整显示约 3 个账号；
- 账号列表内部滚动并保持滚动位置；
- 面板可见且标签页位于前台时，每 10 秒刷新本机详情；
- 最小化、后台标签或日配额编辑期间暂停刷新；
- 运维日志读取有超时保护，不会阻塞账号列表主刷新。

## API 边界

主要只读接口：

```text
GET  /api/v1/admin/accounts
GET  /api/v1/admin/groups/all
POST /api/v1/admin/accounts/today-stats/batch
GET  /api/v1/admin/ops/requests
GET  /api/v1/admin/ops/upstream-errors
GET  /api/v1/admin/accounts/:id/models
```

只有用户点击操作时才调用写接口：

```text
POST /api/v1/admin/accounts/:id/schedulable
POST /api/v1/admin/accounts/:id/recover-state
PUT  /api/v1/admin/accounts/:id
POST /api/v1/admin/accounts/:id/models/sync-upstream
```

## 安全边界

- 复用当前 sub2 后台的 `localStorage.auth_token`，不会在仓库中保存管理员凭据；
- 不读取或外传 API Key 明文；
- 不主动测活、不自动同步模型；
- 不自动调整优先级、池模式、配额或账号状态；
- 不提供伪通用余额查询：第三方 `key/base_url` 没有统一余额协议；
- 不修改 sub2api 源码、镜像、容器或数据库结构。

## 验证

- `node --check sub2-smart-group.user.js`
- `git diff --check`
- Node 纯函数断言覆盖最近命中、路由错误关联、上游状态码、配额字段保留和 URL 安全处理。
