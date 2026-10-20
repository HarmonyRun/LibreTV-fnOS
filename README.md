# LibreTV 飞牛 OS 原生应用（内置 STRM 自动化引擎）

> **项目仓库**：<https://github.com/HarmonyRun/LibreTV-fnOS>  
> **安装包下载**：<https://github.com/HarmonyRun/LibreTV-fnOS/releases>（Release 附件 `libretv-1.0.9.fpk`）  
> 本项目基于开源项目 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)（AGPL-3.0）二次开发，
> 上游 fork：<https://github.com/HarmonyRun/LibreTV>。

把开源 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 封装为飞牛 OS（fnOS）原生
FPK 应用，并在**同一进程**内内置「全自动 STRM 引擎」：

- 在 LibreTV 里搜片 → 详情页点「加入媒体库」→ 后台自动生成 `.strm` 文本文件；
- 飞牛影视把该目录当普通媒体库扫描，**海报墙**立即出现影片；
- 播放时飞牛影视返回 **302 重定向**，客户端直连源站，**NAS 本地只占 KB 级文本**、几乎不耗流量；
- 自动追更：源站新增剧集时，下次同步自动补写新集 STRM；空资源目录自动回收（1.0.9 新增）；
- 每 6 小时自动增量同步（URL 变化自动覆写、新增集数自动补齐、失效条目清理、孤儿文件清扫），并自动调用
  飞牛影视 API 触发**定向扫描**（密钥内置，用户只需填媒体账号密码）。

> 已在 fnOS 1.2.0800 / 飞牛影视 0.9.8-1 实机安装并验证：启动、API、STRM 生成（电影 + 46 集剧集）、
> 增量同步、孤儿清理、重启保留、影视自动识别、**应用内影视兼容代理播放**均通过。
> 说明：影视 0.9.8 原生不支持 HLS 的 STRM 直连，1.0.2 起通过应用内「影视库」代理播放解决（见第九节）。
> 详细证据见 [docs/FINAL-VERIFY.md](docs/FINAL-VERIFY.md)。
> **部署与使用指南（含各步骤截图）**：[Markdown](docs/DEPLOY-GUIDE.md) · [Word](docs/LibreTV-fnOS-部署与使用指南-v1.0.9.docx) · [PDF](docs/LibreTV-fnOS-部署与使用指南-v1.0.9.pdf)

## 📖 图文操作指南（含 19 张实机截图）

| 格式 | 链接 | 说明 |
|---|---|---|
| 在线阅读 | [docs/DEPLOY-GUIDE.md](docs/DEPLOY-GUIDE.md) | 13 个章节，GitHub 直接渲染图片 |
| PDF | [LibreTV-fnOS-部署与使用指南-v1.0.9.pdf](docs/LibreTV-fnOS-部署与使用指南-v1.0.9.pdf) | 28 页 A4，适合打印/分享 |
| Word | [LibreTV-fnOS-部署与使用指南-v1.0.9.docx](docs/LibreTV-fnOS-部署与使用指南-v1.0.9.docx) | 可编辑版本 |
| 截图目录 | [docs/images/deploy-guide](docs/images/deploy-guide) | 19 张原图 |

内容覆盖：fnOS 应用中心安装 → 授权目录 → LibreTV 登录/媒体库配置 → 飞牛影视添加媒体库 →
搜索并加入媒体库 → LAN/公网/中继播放 → 自动追更与空目录回收 → OTA 更新 → MCP 接入 → 排障。

> 截图来自真实运行环境；MCP Token、媒体账号已脱敏，示例 IP `192.168.3.83` 请替换为你的 NAS 地址。


---

## 一、三步配置（用户侧）

### 第 1 步：安装应用（并授权目录）

1. 从 [Releases](https://github.com/HarmonyRun/LibreTV-fnOS/releases) 下载 `libretv-1.0.9.fpk`，打开 **应用中心 → 手动安装** 选择该文件；
2. 安装位置选择 **/vol2**（与 STRM 目录同一存储空间）；
3. 安装向导填写：
   - **STRM 文件根目录**：默认 `/vol2/1000/liberTV/strmdata`（建议保留）。
     请先在「文件管理」中创建这个普通文件夹，再复制绝对路径粘贴；**不要**填
     `/vol2/@appdata/...`、`/var/apps/...` 等应用内部目录——飞牛影视无法选择这些路径。
   - **LibreTV 访问密码**：默认 `libretv`，登录 Web 时使用。
4. 安装完成后，进入 **应用中心 → LibreTV 影视库 → 应用设置 → 授权目录**，
   把第 3 步的 STRM 目录添加为 **读写**（飞牛权限模型要求；应用自身无权自行授权）。
5. 在应用中心启动应用，打开 `http://<NAS-IP>:8090`，用密码登录。

### 第 2 步：在 LibreTV 里「加入媒体库」

1. 搜索想看的电影/剧集 → 点开详情；
2. 点右上角 **「加入媒体库」**，出现「已加入，稍后出现在影视库中」即可，无需等待；
   - 电影 → `电影名 (年份)/电影名 (年份).strm`；
   - 剧集 → `剧集名 (年份)/Season 01/剧集名 - S01E01.strm` …整季。

### 第 3 步：飞牛影视添加媒体库（只需一次）

1. **飞牛影视 → 设置 → 媒体库 → 添加**；
2. 目录选择第 1 步的 STRM 根目录（电影、剧集可分别建库指向同一目录，或建混合库）；
3. 保存并扫描一次。之后引擎新增/变更内容会自动触发定向扫描（见第 4 节）。

完成。以后在 LibreTV 点「加入媒体库」的影片会自动出现在海报墙。

---

## 二、自动刷新飞牛影视（可选，推荐）

STRM 生成后，引擎会调用飞牛影视 API 对**发生变化的目录**做定向扫描。设置路径：
**LibreTV → 设置 → 媒体库 → 飞牛影视自动刷新**。

| 字段 | 说明 |
|---|---|
| 启用 | 打开开关（安装时默认已启用） |
| base_url | `http://127.0.0.1:5666`（默认，无需修改） |
| 用户名 / 密码 | **你的飞牛 OS 登录账号密码**（用于换取影视 API token，只需填一次） |
| secret_string / api_key | 已内置（来自影视前端全局常量），**无需手填**；仅作高级覆盖项 |
| 媒体库名称 | 留空 = 自动匹配路径包含 STRM 根目录的媒体库（可同时匹配电影/剧集库） |

- 填写账号密码后，引擎会自动登录 → 获取 token → 用内置密钥签名 → 调
  `POST /v/api/v1/mdb/scan/<guid> {"dir_list":[...]}`（实测 `code=0`）。
- 未填写账号密码时，自动刷新降级为：`engine.log` 输出待扫描目录 + 尽力更新目录 mtime +
  UI 状态显示「未配置 / 降级」，此时在飞牛影视里手动点一次扫描即可，**不影响 STRM 生成与播放**。

---

## 三、自动化策略（内置，零配置）

| 时机 | 行为 |
|---|---|
| 点「加入媒体库」 | 立即 `202 Accepted`；后台：拉 CMS 详情 → 解析 m3u8 → 写 STRM → 更新索引 → 触发影视扫描 |
| 启动时 | 检查 STRM 根目录；从 `var/strm-index.json` 恢复索引；不扫描全站 |
| 每 6 小时（可调 1–168h） | 遍历索引重新拉详情：URL 变化/新增集数 → 重建补写；本地 `.strm` 缺失 → 自动补齐；CMS 明确不存在**连续 3 次** → 删除；随后快扫清理孤儿 `.strm` 与空目录 |
| 每 5 分钟 | 空资源目录回收：第一层资源目录 0 个 `.strm` 且超过 5 分钟宽限 → 整个目录（含 nfo/海报）删除并清理索引 |
| 每次变更 | 变更的剧名目录去重后调用影视 `mdb/scan` 定向扫描（`-14` 任务冲突自动停任务重试） |
| 手动 | 设置页提供「立即同步 / 立即清理 / 刷新状态」 |

> 引擎**只处理用户主动点「加入媒体库」的条目**，不会抓取全部片源，避免产生大量无人观看的 STRM。

---

## 四、数据与目录

| 路径 | 内容 |
|---|---|
| `/vol2/@appcenter/libretv`（target） | 内置 Node 22 + Next standalone + STRM 引擎 |
| `/vol2/@appdata/libretv/config.json` | 配置（STRM 根目录、密码、影视凭据、预置片源） |
| `/vol2/@appdata/libretv/strm-index.json` | 持久化索引（唯一真实数据，KB 级） |
| `/vol2/@appdata/libretv/state.json` | 引擎运行状态（设置页展示） |
| `/vol2/@appdata/libretv/queue/` | 「加入媒体库」任务队列 |
| `/vol2/@appdata/libretv/{app.log,engine.log}` | 日志 |
| `/vol2/1000/liberTV/strmdata/` | 用户可见的 STRM 根目录（可自定义） |

- 卸载默认保留 `var/`（配置与索引），不递归删除用户 STRM 目录。
- 升级（提升 manifest version）保留 `var/` 与索引。

---

## 五、验证清单（实测结果）

| 项目 | 结果 |
|---|---|
| `fnpack build` | ✅ 零错误，`dist/libretv-1.0.9.fpk` |
| 安装到 /vol2、启动、`/api/auth` 200 | ✅ |
| 引擎单测 / Web 单测 / lint / tsc | ✅ 81 / 440 / 0 / 0 |
| 电影「加入媒体库」→ STRM 落盘 | ✅《沙丘 (2020)》 |
| 剧集「加入媒体库」→ 整季 SxxExx | ✅《庆余年 第一季》46 集 |
| 6h 增量同步 + 孤儿清理 | ✅ checked=2, orphansDeleted=1 |
| 重启应用后索引/STRM 保留 | ✅ 2 条 / 47 个 |
| 飞牛影视自动识别 STRM | ✅ `can_play=1`、`recognition_status=2`（file_monitor 秒级） |
| 影视定向扫描 API | ✅ `code=0 data=true`；`-14` 冲突可停止旧任务 |
| **302 播放** | ⚠️ 需人工点播确认（程序化探测受媒体服务任务状态限制，见 docs/FINAL-VERIFY.md §5、docs/VERIFY-STRM.md §4） |

---

## 六、风险与边界（务必知悉）

1. **CMS 直链时效性**：STRM 写的是源站播放地址，可能因 Token 过期/源站调整失效。6 小时同步是缓解而非根治；
   播放失败时回 LibreTV 重新点一次「加入媒体库」刷新链接。
2. **防盗链**：部分采集站 m3u8 需要 Referer/Cookie，飞牛影视 302 直连可能 403/404。本应用按需求写入直连 URL
   （流量不经过 NAS）；遇到请换源。引擎会在索引标记 `warnings:["no-m3u8"]` 供排查。
3. **302 播放依赖飞牛影视版本与设置**：需影视 ≥ 0.9.1 并开启「直连播放」（设置 → 服务器 → 直连播放，
   `direct_link_enable`）。若播放失败，请先在影视 Web 端人工确认，再判断是否为源站问题。
4. **自动刷新可能降级**：未填媒体账号密码、媒体 API 变更、secret/apiKey 随版本变化时，自动扫描会降级为
   日志提示 + 手动扫描，不影响 STRM 生成与 302 播放能力。
5. **预置片源不由本应用控制**：默认 4 个源健康度无保证（实测优质资源 yzzy-api 本次不可用），连续失败请换源
   （LibreTV → 设置 → 源管理）。
6. **媒体库需用户手动添加一次**：应用无法代替用户创建媒体库；之后新增内容可自动扫描。
7. 同名同年不同源条目会落到同一 STRM 路径，后加入者覆盖内容。
8. 本应用为第三方封装，仅用于技术学习与研究；片源与内容均来自第三方网络。

---

## 七、常见问题

**Q：设置页显示「STRM 根目录不可写」？**
A：到 **应用中心 → LibreTV → 应用设置 → 授权目录**，把该目录添加为「读写」。这是飞牛权限模型的必要一步。

**Q：点了「加入媒体库」，影视库没出现？**
A：检查设置页索引数是否 +1、STRM 目录是否出现文件、飞牛影视媒体库是否指向该目录；未配置自动刷新时手动扫描一次。

**Q：能播放但卡顿/无法播放？**
A：多为源站防盗链或链接失效。换源重新「加入媒体库」，或先在 LibreTV 内直接播放验证源可用。

**Q：Web 打不开 / 忘记密码？**
A：应用中心确认应用运行；`curl http://127.0.0.1:8090/api/auth` 应返回 200。密码在
`/vol2/@appdata/libretv/config.json` 的 `password` 字段，改后重启应用。日志见 `app.log` / `engine.log`。

**Q：如何升级/重装？**
A：提升 `libretv-fpk/manifest` 的 version 后重新构建安装（appcenter 升级会保留 var）；同版本重装会被
appcenter 跳过，需在 Web UI 卸载后重装。

---

## 八、开发与构建

### 环境
- Node.js 22（本地构建）
- `fnpack`（飞牛 NAS 自带 `/usr/local/bin/fnpack`）
- 目标 NAS 可 SSH（`scripts/ssh.sh` 已封装串行锁与重试）

### 构建（本地 → NAS 打包）
```bash
MISSING_ENGINE_FATAL=1 ./scripts/build-fpk.sh
# 产物：dist/libretv-<version>.fpk
# 常用：SKIP_BUILD=1 复用 .next；SKIP_SYNC=1 只本地组装；NODE_VERSION=22.20.0
```

### 安装到 /vol2（非交互）
```bash
# 向导变量文件（UTF-8/LF，无 export、无引号）
cat > /tmp/libretv-install.env <<'EOF'
wizard_strm_root=/vol2/1000/liberTV/strmdata
wizard_password=libretv
EOF
scp dist/libretv-1.0.9.fpk /tmp/libretv-install.env <nas>:/tmp/libretv-deploy/
ssh <nas> 'sudo -n appcenter-cli install-fpk /tmp/libretv-deploy/libretv-1.0.1.fpk -v 2 -e /tmp/libretv-deploy/libretv-install.env'
ssh <nas> 'sudo -n appcenter-cli start libretv'
curl http://<nas>:8090/api/auth
```
或直接 `./scripts/deploy.sh`（含卷校验、载荷完整性检查、root 预授权、健康检查）。

### 测试
```bash
cd libretv
node --test engine/test/     # 引擎单测 81 项
npm run test                 # Web 单测 440 项
npm run lint && npx tsc --noEmit
node engine/cli.js add --data-dir /tmp/strm-test --source <CMS API> --vod-id <id> --type movie
```

### 工程结构
```
libretv/                LibreTV Next.js 15 源码 + engine/（纯 JS STRM 引擎，零 npm 依赖）
libretv/mediaserver/    影视兼容代理（反向代理 + /stream 改写 + HLS 中转）
libretv-fpk/            FPK 工程（manifest / cmd / config / wizard / app / ui）
scripts/build-fpk.sh    构建流水线（Next standalone + Node 运行时 + fnpack）
scripts/deploy.sh       安装部署与健康检查
scripts/ssh.sh          飞牛 SSH 串行封装（锁 + 退避重试）
docs/ARCHITECTURE.md    架构与数据契约
docs/NAS-RECON.md       飞牛环境与影视 API 侦察
docs/VERIFY-STRM.md     STRM 识别/播放链路验证
docs/FINAL-VERIFY.md    最终安装与端到端验证记录
```

---

## 九、影视库播放（1.0.2 新增：应用内兼容代理）

> **安全说明**：应用内置的飞牛影视 API 签名常量（`secret_string` / `api_key`）提取自影视前端
> 公开静态资源，属该接口的客户端公共常量，不是用户凭据；你的飞牛账号密码只保存在 NAS 本地
> `var/config.json`（权限 640），不会上传到任何服务器。


**为什么需要它**：实测飞牛影视 0.9.8 对 `.strm` 只支持**单文件直链**（mp4），HLS(m3u8)
在播放接口会直接报 `DirectLinkPullError`，且默认采集站几乎全部是 HLS。社区通用做法是加
MediaWarp/fntv-proxy 这类代理；本应用把该能力内置，避免额外部署。

**使用方式（全部在应用内完成）**

1. 打开 LibreTV（8090）→ 顶部导航 **「影视库」**（或直接访问 `http://<NAS-IP>:8091/`）；
2. 首次进入按提示登录一次（用你的飞牛影视账号；之后浏览器会记住）；
3. 进入影视 → 点开《沙丘》/《庆余年》→ 播放。

工作原理：

- 8091 是应用内置的反向代理，转发飞牛影视 Web/API（`127.0.0.1:8005`）；
- 代理拦截 `POST /v/api/v1/stream`，把响应里的 `direct_link_qualities[].url` 改写为
  应用中转地址 `/__strm/<签名 token>`，并标记 `is_m3u8=true`；
- 播放器从本应用拉取 m3u8/分片，由 **NAS 统一访问源站**（带 UA/Referer），
  客户端（Mac/手机/平板）只与 NAS 通信——**不需要改动客户端代理，也不受源站防盗链影响**；
- 中转带 HMAC 签名，禁止被当作开放代理使用；随应用启停，日志在 `app.log` 的 `[media-proxy]`。

**边界**

- 播放流量会经过 NAS（不是 302 直连、零流量），这是影视 0.9.8 不支持 HLS 直连的必然代价；
- 飞牛影视 **TV App** 目前无法指定自定义服务器地址，请在手机/平板/电脑浏览器使用
  `http://<NAS-IP>:8091/`；TV 端需等飞牛后续版本支持 HLS STRM；
- 影视 Web 若以后改版（接口/字段变化），代理可能失效；此时 8090 的 LibreTV 与 STRM
  生成/同步不受影响，可在设置中关闭代理（`config.json` → `mediaProxy.enabled=false`）。

---

## 十、远程访问（FN Connect / 飞牛中继）

| 访问方式 | 推荐入口 | 说明 |
|---|---|---|
| 局域网 | LibreTV 8090 + 「影视库」8091 | 兼容代理中转，兼容性最好 |
| 公网直连（有公网 IP/端口映射） | 同上 | 8090/8091 可达即可 |
| **FN Connect / 二级域名 / 飞牛中继** | **飞牛影视原生页面/App** | 中继只转发 fnOS 网关端口，8090/8091 不可达；原生播放由客户端直连源站，不占 NAS/中继带宽 |

> 已实测：FN Connect 中继环境下，使用飞牛影视原生页面播放《沙丘》《庆余年》成功。
> 远程观看者无需打开 LibreTV（8090 仅用于管理员搜索与同步）。
> 个别源若在远程网络不可达/防盗链，请换源重新「加入媒体库」。详见 [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md)。
>
> **Clash 用户注意**：如果使用代理，采集站 CDN 很可能对代理出口返回 403/404，导致「STRM 直连播放异常」。
> 请按 [docs/CLASH-RULES.md](docs/CLASH-RULES.md) 把 CDN 域名加入 DIRECT（规则文件：[clash/rules-snippet.yaml](clash/rules-snippet.yaml)）。

## 十一、MCP 服务（大模型管理，1.0.3 新增）

应用内置 MCP（Model Context Protocol）服务，DeepSeek Harness、WorkBuddy 等 AI 客户端可通过
MCP 搜索资源、加入影视库、删除 STRM、触发同步与媒体库扫描。

- 连接地址：`http://<NAS-IP>:8092/mcp`（独立端口）或 `http://<NAS-IP>:8090/api/mcp`（同源代理）
- 鉴权：`Authorization: Bearer <MCP_TOKEN>`
- Token 获取：LibreTV → 设置 → 媒体库 → STRM 媒体库 → 底部「MCP 服务」查看/复制/重置
- 仅支持 stdio 的客户端：使用 `mcp/stdio-bridge.js` 桥接
- 删除：`remove_from_library` 默认递归删除整个资源目录，传 `season` 只删该季文件夹（其余季保留）；
- 工具：`search_videos`、`add_to_library`、`list_library`、`remove_from_library`、
  `sync_library`、`cleanup_orphans`、`get_engine_status`、`refresh_media_library` 等

详见 [MCP 接入操作文档](docs/MCP-SETUP.md) / [工具说明](docs/MCP.md)。MCP 服务异常不影响 LibreTV 主 Web；FN Connect 中继下
8090/8092 不可达，MCP 请在局域网或公网直连环境使用。

## 十二、OTA 自动更新（1.0.7 新增）

- 启动后 15 秒 + 每 6 小时检查 GitHub Releases；有新版时顶部出现「更新 vX」按钮；
- 点击后自动下载 `libretv-update-<ver>.tar.gz`、用 release digest 做 sha256 校验、原子替换运行文件并自动重启；
- 失败自动回滚；配置 / STRM 索引 / 媒体库数据保留；
- 1.0.3 及更早版本需手动安装一次 1.0.9 FPK，之后即可页面内一键更新；
- 飞牛应用中心显示的是「安装 FPK 的版本」，OTA 后应用内版本更新但应用中心不变，属正常现象；
- 详见 [docs/UPDATE.md](docs/UPDATE.md)。

## 十三、自动追更与空目录回收（1.0.9 新增）

### 自动追更

- 每次增量同步（默认 6 小时，可在设置中设为 1–168 小时）都会重新拉取已入库条目的详情；
- 如果源站新增剧集（如 9 集 → 30 集），自动在对应 `Season NN` 目录补写新增集的 `.strm`，并触发影视扫描；
- 如果本地 `.strm` 被误删但源站 URL 未变，同步时自动补齐缺失文件；
- 同步结果会记录 `episodesAdded` / `filesRestored`，可在引擎日志中查看。

> 想更快追更，把「同步间隔」改为 1–2 小时即可；采集源请求量随条目数线性增加。

### 空资源目录回收

- 每 5 分钟扫描 `strmdata` 第一层资源目录；
- 若某目录内 **0 个 `.strm`**（例如你在飞牛影视/文件管理里把整部剧删掉了）且目录 mtime 超过 **5 分钟宽限**：
  - 递归删除整个资源目录（含 nfo、海报、字幕等所有文件）；
  - 移除 `strm-index.json` 中引用该目录的条目；
  - 触发飞牛影视扫描，海报墙同步消失；
- 宽限期用于避免与「加入媒体库」任务竞争；只处理 `strmdata` 第一层目录，不会删除 `strmdata` 根目录；
- 可配置（`var/config.json`）：
  - `"cleanupEmptyDirs": false` 关闭空目录回收；
  - `"emptyDirGraceMinutes": 10` 调整宽限分钟数（1–60）。

> 只删除部分集数不会触发整目录回收：下次同步会自动补齐缺失集；只有整个资源目录一个 `.strm` 都不剩时才会回收。

## 十四、许可证与致谢

- 本项目以 **AGPL-3.0-or-later** 发布（与上游 LibreTV 一致），见 [LICENSE](LICENSE)。
- 上游项目：[LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)；本项目是面向飞牛 OS 的
  原生 FPK 封装 + STRM 引擎 + 影视兼容代理，未修改上游的核心播放/搜索逻辑（仅新增 STRM 相关入口与 API）。
- 上游 fork：<https://github.com/HarmonyRun/LibreTV>。
- 免责声明：本项目仅用于技术学习与研究；所有片源与内容均来自第三方网络，与作者无关。
  请遵守当地法律法规与内容版权要求。
