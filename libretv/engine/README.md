# LibreTV STRM 自动化引擎（libretv/engine）

纯 Node.js（**CommonJS、零 npm 依赖、Node 22**）实现的 STRM 自动化引擎，随 LibreTV Web
同一进程启动（`start.js` → `require('./engine').startEngine({dataDir, logger})`），
与 Next API 通过 `var/` 目录下的文件通信。契约见 `docs/ARCHITECTURE.md` 第 4/5/6/7 节。

```
Next/Web  --写--> var/queue/job-*.json
                     │  2s 轮询
engine ── 拉 CMS 详情 → 生成/覆写 .strm → 原子写 strm-index.json
                     │
                     ├─ 变更目录去重 → 飞牛影视 refresh（失败降级 utimes）
                     └─ 每 6h（最小 1h）增量同步 + 孤儿清理
```

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `engine/index.js` | 入口：`startEngine({dataDir, logger})` → `{ stop(), getEngine() }`；防重复启动；异常不阻塞 Web |
| `engine/engine-core.js` | `createEngine({dataDir, logger, fetchImpl, now})`：队列、add/refresh/sync/cleanup、状态机、定时器 |
| `engine/naming.js` | `safeName()`、电影/剧集路径、年份、`SxxExx` 两位补零、季集解析 |
| `engine/cms.js` | 苹果 CMS V10 搜索/详情 URL、`fetchDetail`（15s 超时 + 1 次重试 + UA）、`vod_play_url` 多线路/剧集解析、纯函数导出 |
| `engine/index-store.js` | `loadIndex/saveIndex`（tmp+rename 原子写）、损坏备份重建、`entryKey`、upsert/remove |
| `engine/fnv-client.js` | 飞牛影视客户端：MD5 authx 签名、双端点（mediadb→mdb 回退）、login 缓存、`-2` 重登、`-14` 停任务重试、媒体库自动匹配 |
| `engine/fnv-secrets.js` | 签名密钥三级来源：config → 影视前端 bundle 提取（含 XOR 169 解码）→ 内置默认常量 |
| `engine/logger.js` | `engine.log`（ISO + level，>2MB 截断保留末 1MB） |
| `engine/fs-util.js` | 原子写、安全删除、`isInside` 等文件工具 |
| `engine/cli.js` | 本机联调 CLI（run/add/sync/cleanup/status） |
| `engine/test/*.test.js` | `node:test` 单测（62 个） |

所有网络请求使用全局 `fetch` + `AbortSignal.timeout(15000)`，不引入任何第三方包。

## 2. 数据结构

### 2.1 config.json（engine 只读，每次任务/心跳重新读取）

```json
{
  "port": 8090,
  "password": "libretv",
  "strmRoot": "/vol2/1000/liberTV/strmdata",
  "syncIntervalHours": 6,
  "fnv": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:5666",
    "appName": "trimemedia-web",
    "username": "admin",
    "password": "******",
    "secretString": "******",
    "apiKey": "******",
    "libraryName": ""
  }
}
```

- `strmRoot` 必须是绝对路径；未配置/无效时引擎只轮询队列，`state.setupNeeded=true`，并在
  `var/setup-needed` 留标记文件。
- `syncIntervalHours` 默认 6，读取时钳制到 **[1, 168]**，改配置无需重启。
- `fnv.enabled=false` 或缺少媒体账号/密码时跳过刷新（`state.fnv.configured=false`、`lastMode="disabled"`）。
- `fnv.secretString` / `fnv.apiKey` **可以留空**：引擎会自动从本机影视前端 bundle 提取，失败再使用内置常量；
  用户填写的值优先，可覆盖自动结果。

### 2.2 queue/job-*.json（Next 写、engine 消费，格式冻结）

```json
{
  "id": "job-1710000000000-a1b2c3",
  "createdAt": "2026-10-19T03:00:00.000Z",
  "action": "add",
  "payload": {
    "sourceApiBase": "https://cj.lziapi.com/api.php/provide/vod",
    "sourceName": "量子资源",
    "sourceDetailBase": "",
    "vodId": "1197",
    "vodName": "沙丘",
    "vodYear": "2020",
    "type": "movie"
  }
}
```

`action`：`add` / `refresh`（payload 可只带 `sourceApiBase` + `vodId`）/ `sync` / `cleanup`。

- 引擎按文件名排序消费；先 `rename` 到 `queue/processing/`，成功删除，失败移到
  `queue/failed/<原文件名>`，只保留最近 50 个。
- 启动时会把 `queue/processing/` 里上次崩溃遗留的任务移回队列。
- 所有队列/索引/状态文件由 Next 与引擎各自原子写（tmp + rename）。

### 2.3 strm-index.json（engine 独占写，契约 4.3）

```json
{
  "version": 1,
  "updatedAt": "2026-10-19T03:05:22.100Z",
  "entries": {
    "https://cj.lziapi.com/api.php/provide/vod::1197": {
      "type": "movie",
      "title": "沙丘",
      "year": "2020",
      "sourceName": "量子资源",
      "sourceApiBase": "https://cj.lziapi.com/api.php/provide/vod",
      "vodId": "1197",
      "strmPaths": ["/tmp/.../strm/沙丘 (2020)/沙丘 (2020).strm"],
      "lastKnownUrls": ["https://vip1.lz-cdn1.com/20220325/489_5e94e9e8/index.m3u8"],
      "lastSyncedAt": "2026-10-19T03:05:22.098Z",
      "consecutiveFailures": 0,
      "lastError": ""
    }
  }
}
```

- key = `sourceApiBase.trim().replace(/\/+$/,'') + "::" + vodId`。
- 路径一律为 `path.resolve` 后的绝对路径。
- 扩展字段：`warnings: ["no-m3u8"]`（所选线路无 m3u8 直链时写入，UI 可提示重新入库；为空时省略）。
- 文件损坏（JSON 解析失败或 `entries` 结构非法）时自动备份为
  `strm-index.json.corrupt-<timestamp>.bak` 并原子重建空索引。

### 2.4 state.json（engine 独占写，UI 只读）

```json
{
  "setupNeeded": false,
  "engine": {
    "pid": 1234,
    "startedAt": "2026-10-19T03:00:00.000Z",
    "lastTickAt": "2026-10-19T03:05:30.000Z",
    "lastSyncAt": "2026-10-19T03:05:25.000Z",
    "lastSyncResult": { "checked": 2, "updated": 0, "deleted": 0, "orphansDeleted": 0, "errors": 0 },
    "queuePending": 0,
    "processingJob": "",
    "lastResult": { "at": "ISO", "action": "add", "jobId": "job-...", "ok": true, "result": {} }
  },
  "fnv": {
    "configured": true,
    "lastOkAt": "ISO",
    "lastError": "",
    "lastMode": "api",
    "endpoint": "mediadb",
    "secretSource": "builtin",
    "matchedLibraries": [{ "guid": "...", "name": "LibreTV 电影" }]
  },
  "paths": { "strmRoot": "/vol2/1000/liberTV/strmdata", "indexCount": 2, "setupNeeded": false }
}
```

- `state.json` 心跳写盘节流为 **30s**（有变更立即写），减少 NAS 上的小额写放大；
  `lastTickAt` 反映最近一次 2s 心跳。
- `lastResult` 只存概要（文件数/URL 数），不会把全部 URL 写进 state。
- `fnv.lastMode`：`api`（刷新成功）/ `fallback`（失败降级 utimes）/ `disabled` / `idle`。
- `fnv.endpoint`：最近一次成功使用的媒体库端点（`mediadb` / `mdb`），便于 UI/排障显示。
- `fnv.secretSource`：签名密钥来源（`config` / `bundle` / `builtin` / `mixed` / `none`），**不包含密钥原文**。

## 3. STRM 命名规则

- 电影：`<STRM_ROOT>/<片名> (<年份>)/<片名> (<年份>).strm`
- 剧集：`<STRM_ROOT>/<剧名> (<年份>)/Season NN/<剧名> - SxxExx.strm`
- 年份缺失时省略 ` (<年份>)`；季号默认 `01`；集号无法解析时按数组序 1..N。
- 非法文件名字符 `\ / : * ? " < > |` 替换为全角安全字符（`＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜`），
  控制字符替换为空格，去掉首尾空格与点，空标题回退 `Untitled`。
- `.strm` 内容：**单行绝对 URL + `\n`**，UTF-8 无 BOM。
- 季集解析支持：`SxxExx`、`第x季`（含中文数字）、`Season x`、`第x集`、`EPx`/`Ex`、纯数字。

## 4. CMS 解析与多线路选择（Lead 实测结论）

### 4.1 默认可用源（2026-10-19 实测，均支持 `ac=videolist&wd=` 与 `ids=`）

| 名称 | API 地址 |
|---|---|
| 电影天堂资源 | `https://caiji.dyttzyapi.com/api.php/provide/vod` |
| 量子资源 | `https://cj.lziapi.com/api.php/provide/vod` |
| 如意资源 | `https://cj.rycjapi.com/api.php/provide/vod` |
| 优质资源 | `https://api.yzzy-api.com/inc/apijson.php` |

> `yzzy-api` 的响应中文是 `\uXXXX` 转义，`JSON.parse` 后正常；剧集名为「第01集」，解析为 `S01E01`。
> 源站可用性会变化，失败时引擎按「临时错误」保留现有 STRM，不在首次失败时删除。

### 4.2 vod_play_url 解析

`vod_play_url` 用 `$$$` 分线路、`#` 分剧集、`$` 分名称与 URL：

```
第01集$https://.../index.m3u8#第02集$https://.../index.m3u8$$$第01集$https://.../share/xxx
```

**线路选择策略**（`cms.choosePlayLine`）：

1. 计算每条线路中 `.m3u8` 剧集占比；
2. 选占比最高的线路（**全部 m3u8 > 部分 m3u8**，同分取靠前线路）；
3. 所有线路都没有 m3u8 时退化为第一条有效 http(s) 线路。

实测 `dyttzy` / `lziapi` 的 **line0 是 `/share/` 网页中转页（不能直连），line1 才是
`/index.m3u8`**，因此不能只取第一条线路。选中的线路记录在 `detail.chosenLine`
（`index/name/m3u8Ratio/reason`），无 m3u8 时：

- 仍然生成 STRM（保持可播放的 http 直链语义）；
- `logger.warn`；
- 索引写入 `warnings: ["no-m3u8"]`，便于 UI 提示重新入库。

相对 URL 统一用 `sourceApiBase` 的 **origin** 补全；非 http(s) 协议（magnet/ftp 等）直接丢弃。

## 5. 引擎行为

- **启动**：已配置且目录存在 → 直接使用；不存在 → 记录日志并尝试 `mkdir -p`（失败只记日志，
  `setupNeeded=true`，Web 不受影响）。启动即跑一次队列处理，**不立即全量同步**；首次同步在
  `syncIntervalHours` 到达或手动触发。
- **队列轮询**：2s；定时器 `unref()`，不阻止进程退出。
- **add**：拉详情 → 生成/覆写该条目全部 STRM → 清理旧的多余文件 → 更新索引 → 变更目录入待刷新集合。
- **refresh**：按索引找到条目后复用 add 流程。
- **sync（全量增量）**：遍历索引条目，逐条串行请求详情（条目间隔 **200ms**，避免打爆源站）；
  - URL 列表变化 → 覆写 STRM + 更新索引；
  - CMS 明确条目不存在（`list` 为空且 code 正常）→ `consecutiveFailures++`，**连续 3 次**才删除
    STRM 并移除索引；
  - 网络/5xx/解析失败 → 同样 `++` 但**保留文件**，日志与 `lastError` 区分；
  - 成功 → 失败计数清零。
- **cleanup**：递归扫描 `strmRoot` 下所有 `.strm`，与索引路径全集做差集删除孤儿；
  只清理**因删除而变空**的 Season/剧名目录；绝不删除 `strmRoot` 本身、非 `.strm` 文件或符号链接。
- **刷新去重**：一次队列批次/一次 sync 收集所有变更的「剧名目录」（电影为片名目录）绝对路径，
  去重后**一次**传给飞牛影视。
- **日志**：`var/engine.log`，格式 `2026-10-19T12:00:00.000Z [info] message`；>2MB 截断保留末 1MB。

## 6. 飞牛影视（FnvClient）

### 6.1 真实端点（双端点 + 自动回退）

fnOS 1.2 / 影视 0.9.8 的真实端点为 `mediadb/*`；旧 quark 插件使用的 `mdb/*` 作为兼容回退：

| 用途 | 首选（真实） | 回退（旧名） |
|---|---|---|
| 媒体库列表 | `GET /v/api/v1/mediadb/list` | `GET /v/api/v1/mdb/list` |
| 触发扫描 | `POST /v/api/v1/mediadb/scan/<guid>` | `POST /v/api/v1/mdb/scan/<guid>` |
| 登录 | `POST /v/api/v1/login`（不校验 authx） | — |
| 停任务 | `POST /v/api/v1/task/stop` | — |

- 每次请求先走 `mediadb/*`；遇到 **404 / 501 / 非 code 0 / 网络错误** 自动回退 `mdb/*`；
- 一旦某个端点成功，进程内缓存为 `client.activeEndpoint`，后续请求优先使用它（失败仍可回退）；
- 最近一次成功端点写入 `state.fnv.endpoint`；请求尝试明细在返回值 `attempts` 中（日志可排障）；
- 501 不重试，直接回退（避免为“端点未实现”白等一次）。

### 6.2 签名（NAS 实测版，与 quark-auto-save `fnv.py` 同源）

```
nonce     = 6 位随机数字
timestamp = 毫秒时间戳字符串
GET       serialized = urlencode(sorted(params))   # 无参数时 "" → md5("")
POST      serialized = JSON.stringify(body)        # 前端不排序；本引擎 scan body 只有 dir_list 单键/空对象，等价
bodyHash  = md5(serialized)
sign      = md5([secretString, path, nonce, timestamp, bodyHash, apiKey].join("_"))
authx     = "nonce=<nonce>&timestamp=<timestamp>&sign=<sign>"
```

- 请求头：`authx`、`Content-Type: application/json`；登录后附 `Authorization: <token>`。
- 登录端点不校验 authx；token 来自用户填写的**媒体账号密码**（不读 DB、不抓浏览器）。
- `code===0` 成功；`-2` 重新登录后重试（最多 3 次）；`-14` 先 `task/stop`
  `{guid, type:"TaskItemScrap"}` 再重试；所有异常捕获后返回 `{ok:false,error}`。
- 支持注入 `fetchImpl`；`buildAuthx()` 为纯函数。单测固定向量包含：
  - quark 风格假密钥 4 组（独立 Python 复算）；
  - **真实 bundle 常量**的 login / mediadb-list / mediadb-scan 3 组（见 6.3）。

### 6.3 密钥来源：三级自动解析（用户只需填账号密码）

`secret_string` / `api_key` 不是用户凭据，而是影视前端 bundle 里的**全局常量**（NAS-RECON §4.4）。
解析顺序（`engine/fnv-secrets.js`，字段仍沿用契约，不新增配置项）：

1. **config 显式值**：`config.fnv.secretString` / `apiKey` 非空 → 直接使用（用户可覆盖）；
2. **本机 bundle 提取**：读取 `/usr/local/apps/@appcenter/trim.media/static/assets/*.js`
   （默认取体积最大/最新的若干文件，可用 `LIBRETV_FNV_BUNDLE_DIR` 或
   `createEngine({fnvBundleDir})` 覆盖路径）：
   - secret：匹配 `secret_string` / `secret` 赋值；无明确赋值时在 28–40 位全局常量中，
     优先选择上下文含 `secret/authx/nonce/timestamp` 的候选（多候选且无线索时放弃，避免误取）；
   - api_key：匹配 `api_key` / `apiKey` 赋值；或扫描前端字节数组并按 **XOR 169** 解码，
     取解码后为 UUID 的常量（影视前端 `vh` 的实现）；
3. **内置默认常量**（随影视 0.9.8-1 实测固定，用户 config 可覆盖）：
   - secret：`NDzZTVxnRKP8Z0jXg1VAMonaG8akvh`
   - apiKey：`16CCEB3D-AB42-077D-36A1-F355324E4237`

解析结果按配置签名缓存（进程内只读一次 bundle），只把来源写 `state.fnv.secretSource`，
**日志绝不输出密钥原文**。bundle 不存在时静默回退内置常量；缺媒体账号密码/未启用 →
`configured=false`，UI 显示未配置，刷新走降级（日志 + utimes）。

### 6.4 媒体库自动匹配（零配置体验）

1. `config.fnv.libraryName` 非空 → 按名称精确匹配（大小写敏感优先，再忽略大小写），命中即只用该库；
2. 为空或名称找不到 → 登录后 `mediadb/list`（失败自动回退 `mdb/list`），从
   `dir_list/dirList/paths/path/dirs/...` 等字段提取路径，与 `strmRoot` 做双向前缀匹配；
   **同一目录可能同时是「电影」「剧集」两个库，命中的所有 guid 都会 refresh**；
3. 媒体库路径字段名未知 → 把完整媒体库 JSON 写入 `engine.log` 便于适配；若仅一个媒体库则回退用它；
4. 匹配结果写回 `state.fnv.matchedLibraries: [{guid,name}]`，不改 config。

### 6.5 dir_list 与降级

- `dir_list` = 本次新增/覆写/删除的剧名目录绝对路径集合（去重、只保留仍存在的目录）；
- 带 `dir_list` 刷新失败 → 自动降级为**不带 dir_list 全库扫描一次**，并记录日志；
- 仍失败/没有可用媒体库/列表解析失败 → `logger.warn` + `fs.utimes` 更新变更目录 mtime（best effort）
  + `state.fnv.lastMode="fallback"` + `state.fnv.lastError`；
- 默认 `baseUrl`：`http://127.0.0.1:5666`（fnOS 网关，路径 `/v/api/v1/...`）；
  manifest 的 `service_port=8005` 是媒体服务直连端口，可在设置中覆盖 baseUrl。

## 7. CLI

在 `libretv/` 目录下执行：

```bash
# 只处理一轮队列（联调 queue → STRM）
node engine/cli.js run --data-dir <dir> --once

# 后台常驻（2s 队列轮询 + 定时同步，Ctrl+C 退出）
node engine/cli.js run --data-dir <dir>

# 立即新增/刷新一个条目
node engine/cli.js add --data-dir <dir> \
  --source https://cj.lziapi.com/api.php/provide/vod \
  --vod-id 1197 --type movie --name 沙丘 --year 2020 --source-name 量子资源

# 立即增量同步 + 孤儿清理 + 刷新媒体库
node engine/cli.js sync --data-dir <dir>

# 只清理孤儿 .strm
node engine/cli.js cleanup --data-dir <dir>

# 打印 state/索引概要
node engine/cli.js status --data-dir <dir>
```

`--data-dir` 必填（也可用 `LIBRETV_DATA_DIR` / `TRIM_PKGVAR` 环境变量）。`add` 需要该目录
`config.json` 中已配置 `strmRoot`。CLI 与 Web 共用同一套文件契约，可直接指向 `$TRIM_PKGVAR`。

## 8. 测试

```bash
cd libretv
node --test engine/test/
```

当前结果：**81 tests / 81 pass / 0 fail**（Node v22.23.2）。覆盖：

- 命名规范：电影/剧集、非法字符、缺年份、`SxxExx` 补零、中文季集/EP/纯数字/回退；
- CMS：URL 构造、多线路（**m3u8 在第二条**、全 m3u8 优先、无 m3u8 回退）、
  第01集 → S01E01、相对 URL、`\uXXXX` 中文、条目不存在 vs 临时错误、5xx 重试；
- 索引：原子写（无 `.tmp` 残留）、损坏备份重建、warnings 持久化、upsert/remove；
- 引擎：电影/剧集落盘与索引结构、URL 变化覆写、连续 3 次不存在才删除、网络错误保留文件、
  孤儿清理（含空目录、非 `.strm` 保留、root 保留）、队列 add/非法任务进 failed、state 字段；
- FNV：quark 风格 4 组 + **真实 bundle 常量 3 组**签名固定向量、login 缓存、`-2` 重登、
  `-14` 停任务、网络异常不抛出、双端点（mediadb 成功 / 404 / 非 code 0 / scan 501 回退 mdb）、
  多库自动匹配、显式库名优先、dir_list 失败全库扫描、失败降级 utimes + `lastMode=fallback`；
- FNV 密钥：config 覆盖优先、bundle secret/api_key 提取、XOR 169 解码、bundle 不存在回退内置常量、
  缺账号密码视为未配置；提取 token / mediadb_list / item_guid 等真实响应形态；
  engine 级验证 mock bundle 提取后经 mediadb 端点刷新成功；
- 日志：格式、2MB 滚动、外部 logger 异常隔离。

> `engine/test/index.js` 仅用于兼容部分 Node 版本的 `node --test engine/test/`（目录形式）；
> 用 `node --test engine/test/*.test.js` 时不会加载它。

## 9. 真实 CMS 端到端冒烟（2026-10-19）

环境：macOS + Node v22.23.2，公网可访问上述源站。

```bash
rm -rf /tmp/libretv-strm-e2e && mkdir -p /tmp/libretv-strm-e2e/strm
cat > /tmp/libretv-strm-e2e/config.json <<'EOF'
{ "port": 8090, "strmRoot": "/tmp/libretv-strm-e2e/strm", "syncIntervalHours": 6, "fnv": { "enabled": false } }
EOF

cd libretv

# 电影：量子资源
node engine/cli.js add --data-dir /tmp/libretv-strm-e2e \
  --source https://cj.lziapi.com/api.php/provide/vod \
  --vod-id 1197 --type movie --name 沙丘 --year 2020 --source-name 量子资源

# 剧集：电影天堂资源（line0=/share/，line1=m3u8，验证多线路选择）
node engine/cli.js add --data-dir /tmp/libretv-strm-e2e \
  --source https://caiji.dyttzyapi.com/api.php/provide/vod \
  --vod-id 35200 --type tv --name "庆余年 第一季" --year 2019 --source-name 电影天堂资源

node engine/cli.js sync    --data-dir /tmp/libretv-strm-e2e
node engine/cli.js cleanup --data-dir /tmp/libretv-strm-e2e
```

实际结果：

```
已生成 STRM: 沙丘 (2020) type=movie files=1 key=https://cj.lziapi.com/api.php/provide/vod::1197
已生成 STRM: 庆余年 第一季 (2019) type=tv files=46 key=https://caiji.dyttzyapi.com/api.php/provide/vod::35200

/tmp/libretv-strm-e2e/strm/
├── 沙丘 (2020)/沙丘 (2020).strm
│   └── https://vip1.lz-cdn1.com/20220325/489_5e94e9e8/index.m3u8
└── 庆余年 第一季 (2019)/Season 01/
    ├── 庆余年 第一季 - S01E01.strm
    │   └── https://vip.dytt-tvs.com/20251221/8140_e2db7186/index.m3u8
    ├── ...（共 46 集）
    └── 庆余年 第一季 - S01E46.strm

总 .strm 文件：47
sync   → { "checked": 2, "updated": 0, "deleted": 0, "orphansDeleted": 0, "errors": 0 }
cleanup→ { "orphansDeleted": 0, "dirsRemoved": 0 }
索引   → 2 条（movie 1 文件 / tv 46 文件），warnings 均为空
```

关键验证点：两条真实源均返回 `$$$` 多线路，且 **m3u8 都不在 line0**；引擎正确选中了
`lzm3u8` / `dyttm3u8` 线路，生成的 `.strm` 内容是单行 **绝对 m3u8 URL**，路径符合契约 5。
（未配置 `fnv` 时刷新为 `skipped: not-configured`，不影响落盘。）

## 10. 已知限制与风险

1. **飞牛影视真实 refresh 未在 NAS 由本引擎实测**：端点/签名/常量已按 NAS-RECON §4 对齐，
   `mediadb/list`、`mediadb/scan` 与真实常量均写进单测固定向量；媒体库返回字段名与 token 字段名
   做多键兼容，字段不同会打印完整 JSON 到 `engine.log`。最终 NAS 安装后的 refresh 由 Lead 实测。
2. **`no-m3u8` 条目**：`/share/` 网页中转链接即使生成了 `.strm` 也可能无法 302 播放；索引中的
   `warnings:["no-m3u8"]` 供 UI 提示重新入库，引擎不会因此删除条目。
3. **网络错误不删文件**：只有 CMS 明确「条目不存在」累计 3 次才删除；临时网络故障只会累计
   `consecutiveFailures` 并保留文件（避免源站抖动误删媒体库）。
4. **同步串行 200ms 间隔**：几百条目的全量同步会持续数分钟，属预期；不会并发打爆源站。
5. **首次同步不立即执行**：启动后首个全量同步在 `syncIntervalHours` 到达或手动
   `/api/strm/action`（或 CLI `sync`）时触发，避免每次应用启动都全量打源站。
6. **文件系统权限**：`strmRoot` 必须对运行用户（`libretv`）可写；`mkdir` 失败只记日志并
   `setupNeeded=true`，引擎继续轮询队列，不阻塞 Web。
7. **strmRoot 与媒体库匹配**：自动匹配支持双向前缀；若同一路径同时被添加为电影/剧集库，
   会 refresh 所有命中 guid。若用户媒体库路径与 `strmRoot` 无包含关系，需显式填写 `libraryName`。
8. **前端常量随影视版本变化**：内置常量来自 0.9.8-1；媒体升级后若签名失败，优先依赖本机 bundle
   自动提取（会自动读新版本常量），仍失败可在设置里手工覆盖 `secretString/apiKey`，或按日志降级。
9. **state 心跳 30s**：UI 轮询 `state.json` 时 `lastTickAt` 最坏延迟约 30s，但队列/同步/刷新等
   事件会立即触发写盘。
10. **同名同年条目路径冲突**：契约固定了 `<片名> (<年份>)` 目录，不同源的同名同年影片/剧集会落到
    同一路径（后写入者覆盖内容，索引仍各保留一条）。这是契约路径规则的固有限制，UI 应尽量避免
    同一标题同时入库多个源。
11. **目录清理范围**：cleanup 只清理「因孤儿删除而变空」的目录，不会主动删除用户自己创建的
    无关空目录；也不会跟随/删除符号链接。
