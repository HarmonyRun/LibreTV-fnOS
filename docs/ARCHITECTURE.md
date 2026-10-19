# LibreTV fnOS 原生应用 — 架构与开发契约（冻结版 v1）

> 所有 teammate 必须遵守本文件中的路径、数据格式、端口与接口约定。不要自行改动契约；如必须改，先通知 Lead。

## 1. 交付物与仓库布局

```
<repo-root>/
├── libretv/                 # LibreTV Next.js 源码（fork，web-dev 负责 src/**，engine-dev 负责 engine/**）
│   ├── src/                 # Next.js 应用（frontend + API routes）
│   ├── engine/              # 纯 JS STRM 引擎（CommonJS，无第三方依赖，engine-dev 负责）
│   ├── start.js             # 进程入口：先启动引擎，再 require Next standalone server.js（Lead 负责）
│   └── ...                  # 上游文件
├── libretv-fpk/             # FPK 工程（fpk-dev 负责）
│   ├── manifest
│   ├── cmd/{main,install_init,install_callback,uninstall_init,uninstall_callback,upgrade_init,upgrade_callback,config_init,config_callback}
│   ├── config/{privilege,resource}
│   ├── wizard/{install,config,uninstall}
│   ├── ui/config + ui/images/{icon_64.png,icon_256.png}
│   ├── ICON.PNG / ICON_256.PNG
│   └── app/                 # 打包载荷（构建时生成，勿手改）
│       ├── node/bin/node    # 内置 linux-x64 Node 22 运行时
│       ├── server/          # Next standalone + engine/ + start.js
│       └── ui/...
├── scripts/                 # 构建/部署脚本（fpk-dev + Lead）
├── docs/                    # 文档（Lead）
└── README.md                # 用户三步配置 + 风险说明（Lead）
```

应用名（manifest `appname`）：`libretv`。显示名：`LibreTV 影视库`。版本 1.0.1。

## 2. 运行模型（单进程）

- cmd/main 用内置 node 启动 `$TRIM_APPDEST/server/start.js`，cwd = `$TRIM_APPDEST/server`。
- start.js 先 `require('./engine').start({...})` 启动后台 STRM 引擎（定时器 + 队列轮询），再 `require('./server.js')` 启动 Next standalone HTTP 服务。**不允许第二个 Node 进程。**
- Next 服务监听 `0.0.0.0:$TRIM_SERVICE_PORT`，默认/固定端口 **8090**（manifest `service_port=8090`，`checkport=true`）。
- 运行用户：`package`（专用用户 `libretv` / 组 `libretv`）。

## 3. 环境变量（start.js 读取）

| 变量 | 来源 | 说明 |
|---|---|---|
| `TRIM_PKGVAR` | fnOS | 运行时数据目录（var），start.js 传给引擎与 Next |
| `TRIM_APPDEST` | fnOS | target 目录 |
| `TRIM_SERVICE_PORT` | fnOS | 8090 |
| `LIBRETV_DATA_DIR` | cmd/main 设置 | 显式数据目录，默认 `$TRIM_PKGVAR` |
| `PASSWORD` | cmd/main 从 config.json 读出 | LibreTV 登录密码，默认 `libretv` |
| `NODE_ENV` | cmd/main | `production` |
| `PORT` / `HOSTNAME` | start.js 设置 | Next standalone 用 |

## 4. `var/` 数据契约（engine 与 Next API 共享）

```
$TRIM_PKGVAR/
├── config.json          # 用户/安装配置（Next settings 可写，engine 只读）
├── strm-index.json      # 引擎独占写（原子写：tmp+rename）
├── state.json           # 引擎独占写，供 UI 读状态（原子写）
├── queue/               # 任务队列，Next 写、engine 消费（原子写）
│   ├── job-<ts>-<rand>.json
│   └── processing/      # engine 取走后移入；失败移动到 failed/
├── engine.log           # 引擎运行日志（追加，UTF-8）
└── setup-needed         # （可选）首次未配置 STRM 目录时存在
```

### 4.1 config.json

```json
{
  "port": 8090,
  "password": "libretv",
  "strmRoot": "/vol2/1000/liberTV/strmdata",
  "syncIntervalHours": 6,
  "movieLibraryName": "LibreTV 电影",
  "tvLibraryName": "LibreTV 剧集",
  "fnv": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:5666",
    "appName": "trimemedia-web",
    "username": "",
    "password": "",
    "secretString": "",
    "apiKey": "",
    "libraryName": ""
  },
  "sources": [
    { "key": "builtin_0", "name": "默认源", "url": "https://example.com/api.php/provide/vod" }
  ]
}
```

- engine 每次任务/轮询时**重新读取** config.json，改配置无需重启。
- Next settings 写入时必须做字段校验：`strmRoot` 必须为绝对路径、不能位于 `/vol*/@app*`、`/var/apps`、`/usr`、`/etc` 等应用内部或系统目录；同步间隔 1–168 小时。
- 前端读取 config 时**必须脱敏**：`password`/`fnv.password`/`fnv.secretString`/`fnv.apiKey` 不得下发原文。

### 4.2 队列任务 schema

文件名：`job-<epochMs>-<6位随机>.json`（Next 写临时文件后 rename）。engine 轮询 `queue/*.json`，按文件名排序处理。

```json
{
  "id": "job-1710000000000-a1b2c3",
  "createdAt": "2026-10-19T03:00:00.000Z",
  "action": "add",
  "payload": {
    "sourceApiBase": "https://example.com/api.php/provide/vod",
    "sourceName": "示例源",
    "sourceDetailBase": "",
    "vodId": "12345",
    "vodName": "沙丘",
    "vodYear": "2021",
    "type": "movie"
  }
}
```

`action` 取值：
- `add`：新增/刷新一个影片/剧集条目（payload 同上，`type` 可为 `movie` | `tv`）。
- `refresh`：payload 只需 `{sourceApiBase, vodId}`，按索引重新同步该条目。
- `sync`：全量增量同步（payload `{}`）。
- `cleanup`：仅执行快扫清理。

engine 处理完成后：
- 成功：删除 queue 文件，写 `state.json.lastResult`。
- 失败：移动至 `queue/failed/<原文件名>`（保留最近 50 个），写日志与 state。

### 4.3 strm-index.json

```json
{
  "version": 1,
  "updatedAt": "ISO",
  "entries": {
    "<sourceApiBase>::<vodId>": {
      "type": "movie",
      "title": "沙丘",
      "year": "2021",
      "sourceName": "示例源",
      "sourceApiBase": "https://...",
      "vodId": "12345",
      "strmPaths": ["/vol2/1000/liberTV/strmdata/沙丘 (2021)/沙丘 (2021).strm"],
      "lastKnownUrls": ["https://.../index.m3u8"],
      "lastSyncedAt": "ISO",
      "consecutiveFailures": 0,
      "lastError": ""
    }
  }
}
```

- 路径一律存**绝对路径**（path.resolve 后）。
- 写索引必须原子：写 `.tmp` 再 `rename`。
- `entries` key 由 `sourceApiBase.trim().replace(/\/+$/,'')` + `::` + `vodId` 组成。

### 4.4 state.json

```json
{
  "engine": {
    "pid": 1234,
    "startedAt": "ISO",
    "lastTickAt": "ISO",
    "lastSyncAt": "ISO",
    "lastSyncResult": { "checked": 3, "updated": 1, "deleted": 0, "orphansDeleted": 0, "errors": 0 },
    "queuePending": 0,
    "processingJob": ""
  },
  "fnv": { "configured": true, "lastOkAt": "ISO", "lastError": "", "lastMode": "api" },
  "paths": { "strmRoot": "/vol2/1000/liberTV/strmdata", "indexCount": 3 }
}
```

## 5. STRM 规则（engine 唯一实现）

- 电影：`<STRM_ROOT>/<片名> (<年份>)/<片名> (<年份>).strm`
- 剧集：`<STRM_ROOT>/<剧名> (<年份>)/Season NN/<剧名> - SxxExx.strm`
- 年份缺失：省略 ` (<年份>)`。剧集季号默认 `01`，从剧集名解析 `SxxExx` / `第x季` / `Season x`。
- 非法文件名字符 `\ / : * ? " < > |` 与控制字符 → 替换为空格或全角安全字符；去掉首尾空格与点；空标题回退为 `Untitled`。
- `.strm` 内容：**单行绝对 URL + `\n`**，UTF-8 无 BOM。
- 剧集文件名必须包含 `SxxExx`（两位补零）。
- 同一剧集多线路：优先选 m3u8 线路（第一条包含 .m3u8 的有效线路），否则第一条 http(s) 线路。解析后若为相对 URL，用 `sourceApiBase` 的 origin 补全。

## 6. 引擎行为（engine-dev）

- 启动：若 strmRoot 存在 → 不重建；若已配置但目录不存在 → 记录日志并尝试 mkdir（失败则 state 标记 error，不阻塞 Web）。
- 队列轮询：2 秒；处理 add/refresh/sync/cleanup。
- 每 `syncIntervalHours`（默认 6h，最小间隔保护 1h）执行一次增量同步：
  - 遍历索引条目 → 重新请求 CMS 详情 → 比较 `lastKnownUrls`；变化则覆写 STRM + 更新索引；CMS 明确条目不存在（`list` 为空且 code 正常）→ `consecutiveFailures++`，**连续 3 次**才删除 STRM 并移除索引；成功则清零。
  - 同步后执行快扫清理：递归扫描 strmRoot 下所有 `.strm`，与索引 `strmPaths` 全集做差集，删除孤儿文件；删除因此变空的 Season/剧名目录（不删 strmRoot 本身，不删非 `.strm` 文件）。
  - 有变更时调用 FnvClient.refresh（dir_list = 变更条目所在剧名目录）；失败降级：写 engine.log + `utimes` 变更目录 mtime（best effort）→ state.fnv.lastMode = "fallback"。
- FnvClient：见第 7 节。配置不完整时直接跳过（`configured=false`），不阻塞。
- 日志：`engine.log`，格式 `2026-10-19T12:00:00.000Z [info] message`，单文件滚动（>2MB → 截断保留末 1MB）。
- 引擎必须可独立测试：提供 `engine/cli.js`，支持
  `node engine/cli.js run --data-dir <dir> --once`、`... add --data-dir ... --source ... --vod-id ...`，
  以及导出 `createEngine(options)` 供单测。
- 网络请求使用 Node 内置 `http/https`/`fetch`（Node 22 全局 fetch 可用），超时 15s，重试 1 次；不引入 npm 依赖。
- 测试：`node --test engine/test/*.test.js`，覆盖 URL 解析、命名、索引原子写、孤儿清理、3 次失败删除、Fnv 签名（对已知向量）。

## 7. FnvClient（飞牛影视 API）

接口（engine/fnv-client.js）：
- `login()` → token；POST `/v/api/v1/login`，body `{username,password,app_name}`。
- `getLibraryId(name)` → guid；GET `/v/api/v1/mdb/list`。
- `refreshLibrary(id, dirList?)` → boolean；POST `/v/api/v1/mdb/scan/<guid>`，body `{dir_list: [...]}` 或 `{}`。
- 每个请求带 `authx` 头，签名算法（与 quark-auto-save 插件一致）：
  - `nonce` = 6 位随机数字，`timestamp` = 毫秒时间戳字符串；
  - GET：`serialized = urlencode(sorted(params))`；POST：`serialized = JSON.stringify(data, keys sorted, 无空格, 不转义中文)`；无 body 时 `serialized=""`；
  - `bodyHash = md5(serialized)`；
  - `sign = md5([secretString, path, nonce, timestamp, bodyHash, apiKey].join("_"))`；
  - header `authx: nonce=<nonce>&timestamp=<ts>&sign=<sign>`；登录后附加 `Authorization: <token>`；`Content-Type: application/json`。
- 响应 `code === 0` 成功；`code === -2` 重新登录后重试（最多 3 次）；`-14` 先 POST `/v/api/v1/task/stop` `{guid, type:"TaskItemScrap"}` 再重试。
- 支持注入 `fetchImpl` 便于单测。严格不抛出未捕获异常到定时器。
- **实测补充（0.9.8-1）**：secret_string/api_key 是影视前端 bundle 全局常量（`secretString=<MEDIA_SECRET>`、`apiKey=<MEDIA_API_KEY>`），引擎内置默认并支持从 `/usr/local/apps/@appcenter/trim.media/static/assets/*.js` 自动提取；用户只需填媒体账号密码。真实可用端点为 `GET /v/api/v1/mdb/list`、`POST /v/api/v1/mdb/scan/<guid> {"dir_list":[...]}`（实测 code=0）；`-14` 为任务冲突。

## 8. Next API 路由（web-dev）

全部使用 `runtime = "nodejs"`，均调用 `guardRequest`（需登录；详情弹窗按钮仅在登录后可见）。数据目录取 `process.env.LIBRETV_DATA_DIR || process.env.TRIM_PKGVAR || path.join(process.cwd(),'var')`。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/strm/add` | POST | 校验后写队列，立即 `202 {jobId}`；不等待生成 |
| `/api/strm/config` | GET / POST | 读（脱敏）/ 写 config.json（校验）；写后无需重启 |
| `/api/strm/status` | GET | 读 state.json + 索引概要 + engine.log 末 50 行 |
| `/api/strm/action` | POST | `{action:"sync"|"cleanup"|"refresh", sourceApiBase?, vodId?}` → 入队，202 |

- 队列写入必须原子（`fs.writeFile(tmp); fs.rename`），文件名符合 4.2。
- `/api/strm/add` 入参校验：`sourceApiBase` 必须 `^https?://`，`vodId` 非空 ≤64 字符，`type ∈ {movie,tv}`。
- 所有路由 catch 后返回 JSON 错误，不 500 崩溃。

## 9. 前端改造（web-dev）

- 详情弹窗（`src/components/detail-modal.tsx`）头部操作区新增「加入媒体库」按钮（图标 + 文案，移动端仅图标），点击调用 `/api/strm/add`：
  - payload：`{sourceApiBase: source.url, sourceName: source.name, sourceDetailBase: source.detail||'', vodId: item.vodId, vodName: item.name, vodYear: info?.year||item.year||'', type: detail && detail.episodes.length > 1 ? 'tv' : 'movie'}`
  - 立即 Toast「已加入，稍后出现在影视库中」；重复点击允许（幂等）。
- 设置抽屉（`src/components/drawer.tsx` / `settings-shared.tsx`）新增「STRM 媒体库」分组：
  - STRM 根目录（文本框 + 保存）、同步间隔（数字，默认 6 小时）；
  - 飞牛影视自动刷新：启用开关、base_url（默认 `http://127.0.0.1:5666`）、用户名、密码、secret_string、api_key、媒体库名称；
  - 保存调用 `POST /api/strm/config`；显示「已配置 / 未配置」状态；
  - 「立即同步」「立即清理」「刷新状态」按钮调用对应 API，展示 `/api/strm/status` 概要（索引条目数、队列、最近同步时间、FnV 状态）。
- 首次进入若 config.strmRoot 为空，显示引导条：文件管理创建普通文件夹 → 复制绝对路径 → 填入设置。
- 不改动现有播放链路；`npm run build`、`npm run lint`、`npm run test` 必须保持通过。

## 10. FPK 约定（fpk-dev）

- manifest 关键项：`appname=libretv`、`version=1.0.0`、`platform=x86`、`source=thirdparty`、`service_port=8090`、`checkport=true`、`ctl_stop=true`、`desktop_uidir=ui`、`desktop_applaunchname=libretv.main`、`os_min_version=1.1.8`。
- `config/privilege`：`run-as=package`，username/groupname = `libretv`。
  **实测：install_init/install_callback 均以应用用户（uid=955）运行，不是 root**，因此不能 chown/trimacl；目录授权需用户在「应用中心 → 应用设置 → 授权目录」完成（fnOS 以 root 补 trimacl ACE）。安装脚本必须任何情况 exit 0，配置自举放在 cmd/main。
- `config/resource`：包含 `api-scope: ["trim.file.userAccess","trim.file.userAcl","trim.file.path"]`（用于未来授权目录），以及 `data-share` 声明一个应用共享目录 `libretv`（rw: libretv）。
- `wizard/install`：STRM 根目录（必填、绝对路径、initValue `/vol2/1000/liberTV/strmdata`，helpText 强调必须是文件管理可见目录、不要用应用内部目录）；访问密码（默认 `libretv`）。可选 FnV secret_string。
- `install_callback`（root 执行）：创建 STRM 目录骨架、写入 `$TRIM_PKGVAR/config.json`（从模板 + 向导变量）、创建 queue/logs 目录；不覆盖已有 config（幂等）。**权限关键路径：飞牛卷为 btrfs `trimacl` 挂载，必须用 `/usr/trim/bin/trimacl -m a:u:<libretv uid>:rwxpDaAeEc:sfd <STRM_ROOT>` 授权应用用户写入（POSIX setfacl 无效）；随后以 libretv 用户实测写入并写 `$TRIM_PKGVAR/perm-ok`，失败则补祖先 `trimacl ... x:s`，仍失败写 `perm-needed` 并在日志提示到「应用设置 → 授权目录」授权；trimacl 不存在时降级 chown。`chown libretv:libretv` + `chmod 2775` 作为辅助。
- `upgrade_*`：绝不删除 `var/`（保留 index）；`uninstall_*`：只删除应用自身数据（var 由系统保留策略决定），**绝不递归删除用户 STRM 根目录**；uninstall 向导提供「是否删除 STRM 目录中的 .strm 文件」选项，默认否。
- `cmd/main`：start/stop/status；pid 文件 `$TRIM_PKGVAR/app.pid`；status 需同时校验 PID 存活与端口/HTTP 探测。
- 构建：`scripts/build-fpk.sh`（本地）：npm build → 组装 app/ → 下载/复用 linux-x64 node → `fnpack build`（FNOS_HOST 上执行）→ 产物 `dist/libretv-1.0.0.fpk`。
- 部署：`scripts/deploy.sh`：rsync 工程到 NAS `/vol2/1000/liberTV/build/`，远端 `fnpack build`，`appcenter-cli install-fpk dist/libretv-*.fpk`，启动并做健康检查。

## 11. 验证清单（nas-verify）

1. `fnpack build` 无错误。
2. `appcenter-cli install-fpk` 安装到 /vol2，`appcenter-cli start libretv`，`cmd/main status` = 0，`curl http://192.168.1.100:8090/api/status` 可用。
3. 手动 STRM 播放链路（先验证）：写入已知 m3u8 的 .strm → 飞牛影视添加目录 → 确认扫描到并 302 播放（media API/日志/HTTP 302 证据）。
4. 引擎单测 + 真实 CMS 详情解析 → STRM 文件树符合命名规范。
5. `/api/strm/add` → 202 → 数秒内 STRM 落盘 → status 显示条目。
6. FnV 探测：获取 secret_string（媒体 app 配置/DB/请求抓取），成功则验证 refresh 调用 code=0；失败则验证降级日志 + mtime 变更。
7. 重启 NAS/应用后索引保留；升级不丢 var；卸载不删用户 .strm。

## 12. 协作与写入范围

| 成员 | 写入范围 |
|---|---|
| Lead | `libretv/start.js`、`docs/**`、`README.md`、`scripts/**`（与 fpk-dev 协调）、最终集成 |
| fpk-dev | `libretv-fpk/**`、`scripts/build-fpk.sh`、`scripts/deploy.sh`、`libretv-fpk/app/ui/**` |
| engine-dev | `libretv/engine/**` |
| web-dev | `libretv/src/**`、`libretv/next.config.ts`、`libretv/package.json`（如需） |
| nas-verify | `libretv-fpk/tests/**`、`docs/VERIFY-*.md`、NAS 端临时目录 |

共享文件冲突时以 Lead 为准；任何契约变更先发消息给 Lead。

## 13. 影视兼容代理（1.0.2 新增，方案 C）

- 代码：`libretv/mediaserver/index.js`，由 `start.js` 在引擎之后启动（同一进程），默认端口 8091，
  可用 `config.json` 的 `mediaProxy.enabled=false` / `mediaProxy.port` 调整。
- 功能：反向代理 `127.0.0.1:8005`；拦截 `POST /v/api/v1/stream`，把
  `direct_link_qualities[].url` 改写为 `/__strm/<HMAC token>` 并置 `is_m3u8=true`；
  `/__strm/*` 负责 HLS 播放列表/分片中转（带 UA/Referer，支持 Range/HEAD）；
  `play/play` 失败时用 `file_stream.path` 或标题匹配兜底改写。
- 安全：中转 token 用 `config.password` 派生密钥 HMAC 签名；不记录密钥原文。
- 边界：影视 0.9.8 原生不支持 HLS STRM 直连，代理以 NAS 中转换取可用性；TV App 自定义
  服务器地址能力待确认，Web/手机浏览器可直接用 `http://<NAS-IP>:8091/`。
