# 最终验证记录（Lead，2026-10-19）

> 目标机：飞牛 fnOS 1.2.0800 / x86_64 / 飞牛影视 trim.media 0.9.8-1
> 应用：libretv 1.0.1，安装于 `/vol2`（target `/vol2/@appcenter/libretv`，var `/vol2/@appdata/libretv`）
> STRM 根目录：`/vol2/1000/liberTV/strmdata`

## 1. 安装与启动

| 项 | 结果 |
|---|---|
| 构建 | `MISSING_ENGINE_FATAL=1 ./scripts/build-fpk.sh` → `dist/libretv-1.0.2.fpk`（52MB，sha256 `69ba58027af8690120e05e34454d6cfc8d800592ebb9d8ffeb451838a61e8d47`） |
| 远端打包 | `fnpack build` 零错误；app.tgz 2529 文件，`node_modules/next/dist` 1411 文件 |
| 安装 | `sudo -n appcenter-cli install-fpk /tmp/libretv-deploy/libretv-1.0.2.fpk -v 2 -e <env>` → Installation complete，check=Installed，版本 1.0.2 |
| 向导变量 | env 文件两行：`wizard_strm_root=/vol2/1000/liberTV/strmdata`、`wizard_password=libretv` |
| 生命周期身份 | install_init/install_callback 均以 uid=955(libretv) 运行（非 root）；脚本已按此设计（不 exit 1，配置自举在 cmd/main） |
| 启动 | `appcenter-cli start libretv` 成功；`curl http://127.0.0.1:8090/api/auth` → 200 `{"success":true,"verified":false}` |
| 首页 | `GET /` → 200（Next.js 15.5.26） |
| 进程 | 单进程：`/vol2/@appcenter/libretv/node/bin/node .../server/start.js`（引擎 + Next 同进程） |
| 端口 | 0.0.0.0:8090 监听 |
| 重启 | stop → start 后 API 200，索引 2 条、STRM 47 个均保留 |

日志：`/vol2/@appdata/libretv/app.log`、`engine.log`、`/var/log/apps/libretv.log`。

## 2. 权限（关键）

- 飞牛卷为 btrfs `trimacl` 挂载，普通 POSIX `setfacl` 无效；需 `/usr/trim/bin/trimacl`。
- 生命周期脚本以应用用户运行，**无法自行授权**；用户需在「应用中心 → LibreTV → 应用设置 → 授权目录」
  将 STRM 目录加为读写（fnOS 以 root 补 trimacl ACE）。本次验证由 root 预授权：
  `trimacl -m a:u:955:rwxpDaAeEc:sfd /vol2/1000/liberTV/strmdata` → 应用用户写入测试通过（`perm-ok`）。
- 安装完成后 `install_callback` 曾报 `mkdir ... Permission denied`（非 root），已改为不阻断并提示授权。

## 3. 端到端 STRM 生成（真实公网 CMS）

登录：`POST /api/auth {"password":"libretv"}` → 200。

| 操作 | 结果 |
|---|---|
| `POST /api/strm/add` 电影（量子资源 id=1197 沙丘 2020） | 202；生成 `/vol2/1000/liberTV/strmdata/沙丘 (2020)/沙丘 (2020).strm`，内容单行 `https://vip1.lz-cdn1.com/20220325/489_5e94e9e8/index.m3u8` |
| `POST /api/strm/add` 剧集（电影天堂 id=35200 庆余年 第一季 2019） | 202；生成 `庆余年 第一季 (2019)/Season 01/庆余年 第一季 - S01E01..S01E46.strm`（46 集，SxxExx 规范） |
| `GET /api/strm/status` | index count=2（movie 1 / tv 1），queuePending=0，日志正常 |
| 剧集名解析 | 「第01集」→ S01E01；m3u8 线路在多条 `$$$` 线路中正确选中（dyttzy 的 line0 是 /share/ 网页，line1 才是 m3u8） |
| 索引 | `strm-index.json` 含 strmPaths / lastKnownUrls / lastSyncedAt / consecutiveFailures=0 |
| 第三方源健康 | 优质资源 yzzy-api 在 NAS 上两次 `fetch failed`（源站/网络问题），其余源正常；属预置源健康风险 |

## 4. 同步与清理

- 手动 `POST /api/strm/action {"action":"sync"}` → 202，完成后：
  `lastSyncResult={"checked":2,"updated":0,"deleted":0,"orphansDeleted":1,"errors":0}`。
- 预置孤儿 `Orphan (1999)/Orphan (1999).strm` → 快扫删除文件并清理空目录，47 个有效 STRM 保留。
- 数据目录 `perm-ok`、`state.json`、`queue/` 结构符合契约。

## 5. 飞牛影视侧

- 媒体服务 trim.media 0.9.8-1，端口 8005，网关 5666；`file_monitor=1` 实时监控。
- **STRM 识别已验证**：把 `.strm` 放入已有媒体库目录后 ≤数秒入库，`item_media.can_play=1`、
  `recognition_status=2`，日志 `strm file scrap completed, skip stream task (will extract on play)`。
- **FnV 自动刷新 API 已验证可用**：用影视前端全局常量签名 + 有效 token 调用
  `POST /v/api/v1/mdb/scan/<guid> {"dir_list":[...]}` → `{"code":0,"data":true}`；
  `GET /v/api/v1/mdb/list` → code 0；重复扫描返回 `-14 Task duplicate`（引擎已实现 task/stop 重试）。
- **原生 302 播放**：影视 0.9.8 不支持 HLS STRM 直连。`play/play` 对 HLS 均返回
  `68157465 = DirectLinkPullError`；用本地 HTTP 中转 m3u8（补全 HEAD/Range）后 fnmov 仍报
  `Invalid data`，证明是影视端协议限制而非网络/防盗链。
- **解决方案（1.0.2）**：应用内影视兼容代理（见第 8 节）——接管影视 Web 并把
  `/v/api/v1/stream` 返回的 `direct_link_qualities[].url` 改写为本应用 HLS 中转地址，
  客户端只访问 NAS，由 NAS 取源站流。

## 6. 交付清单

| 产物 | 路径 |
|---|---|
| FPK 安装包 | `dist/libretv-1.0.2.fpk` |
| FPK 工程 | `libretv-fpk/`（manifest/cmd/config/wizard/app/ui + 图标） |
| 影视兼容代理 | `libretv/mediaserver/`（反向代理 + /stream 改写 + HLS 中转） |
| LibreTV 源码（含引擎/API/UI 改造） | `libretv/` |
| 构建/部署/SSH 脚本 | `scripts/{build-fpk.sh,deploy.sh,ssh.sh}` |
| 用户文档 | `README.md` |
| 架构与契约 | `docs/ARCHITECTURE.md` |
| NAS 侦察 / STRM 验证 | `docs/{NAS-RECON.md,VERIFY-STRM.md}` |

## 7. 遗留与建议

1. **302 播放需人工确认**：这是任务验证清单第 2 步，建议用飞牛影视 Web 或 TV 端点播
   `strmdata` 中已生成的《沙丘 (2020)》《庆余年 第一季》，观察 nginx access log 是否 302。
2. 若 302 仍失败：优先排查媒体侧（直连播放设置 `媒体库 → 设置 → 服务器 → 直连播放`、
   媒体用户权限、源站防盗链），与应用无关；可先用可公网直连的 m3u8 验证。
3. 演示用 STRM 已保留在 `/vol2/1000/liberTV/strmdata`（47 个）；测试临时目录
   `/vol2/1000/电影/_libretv_test` 已清理。
4. 远端构建目录 `/vol2/1000/liberTV/build` 保留以便重新构建，可随时删除。
5. 同版本重装会被 appcenter 跳过；升级请升 manifest version，或在 Web UI 卸载后重装。
6. 预置源健康度无保证（yzzy-api 本次不可用），README 已提示用户换源。


## 8. 影视兼容代理（1.0.2，方案 C）

**目标**：在不改动客户端代理、不依赖影视端 HLS 支持的前提下，让「LibreTV 同步 → 影视海报墙 → 播放」全流程可用。

**实现**（`libretv/mediaserver/`，随 start.js 启动，端口 8091）：

1. 反向代理 `127.0.0.1:8005` 的飞牛影视 Web/API（含 WebSocket 透传），浏览器访问
   `http://<NAS-IP>:8091/` 即可看到原生影视界面；
2. 拦截 `POST /v/api/v1/stream`：影视返回的 `direct_link_qualities[].url` 是源站直链
   （播放器会在客户端直接拉取，因而受代理/防盗链影响），代理将其改写为
   `/__strm/<HMAC token>` 并置 `is_m3u8=true`；
3. `/__strm/*` 中转：拉取源站 m3u8，把子播放列表/分片全部重写回代理，携带浏览器 UA 与
   源站 Referer，支持 Range/HEAD；客户端只与 NAS 通信；
4. 兜底：当 `/stream` 无直链列表时，用 `file_stream.path` 读取 `.strm` 文件内容取源 URL；
   另保留 `play/play` 失败时的标题匹配改写。

**实测证据**（curl 经 8091，使用真实影视 token）：

| 请求 | 结果 |
|---|---|
| `GET /v/`（影视首页） | 200 text/html |
| `GET /v/api/v1/sys/version` | 200 `{"code":0,...0.9.8}` |
| `POST /v/api/v1/stream`（沙丘 media_guid） | `direct_link_qualities[0].url = /__strm/...`，`is_m3u8=true` |
| `POST /v/api/v1/stream`（庆余年 S01E01） | 同上，改写为 dytt 源中转地址 |
| `GET /__strm/<token>` | 200 `application/vnd.apple.mpegurl`（主列表已重写） |
| 子列表 | 200 m3u8（variant 已重写） |
| 分片 | 200 `video/mp2t`（实际字节） |
| 重启应用后 | 8090/8091 均恢复 200，索引 2 条 / STRM 47 个保留 |

**边界**：
- 播放流量经过 NAS（非 302 零流量），是影视 0.9.8 限制下的可靠解；
- TV App 若不能自定义服务器地址，暂无法使用代理入口；建议手机/平板/电脑浏览器访问 8091；
- 影视改版导致接口变化时代理可能失效，可在 `config.json` 设 `mediaProxy.enabled=false` 关闭，
  不影响 LibreTV 主功能。

## 9. 远程访问验证（FN Connect / 中继，方案 D）

**结论：D 成立，应用零改动。**

- 实测环境：FN Connect 二级域名 / 中继连接 + 飞牛影视原生页面；
- 结果：**《沙丘》《庆余年》播放成功**；
- 流量路径：客户端 → 源站（视频流不经过 NAS，也不经过中继），中继只承载页面/API；
- 技术前置（已验证）：
  - 中继只转发 fnOS 主网关（443/5666/5667），`:8090`/`:8091` 从外网超时；
  - 原生影视 `/v/api/v1/stream` 返回 `direct_link_qualities[].url` 为源站直链；
  - 播放器使用 hls.js（XHR）直接取流，源站响应 `access-control-allow-origin: *`，浏览器可跨域播放；
- 使用建议：局域网/公网直连继续用 8090 + 「影视库」8091；中继/远程观看使用**飞牛影视原生页面/App**，不要用 8091 入口。
- 已知风险：个别源站 CDN 对部分客户端网络不可达（全球节点抽样存在 200/404 差异），远程播放失败时换源重试。

## 10. MCP 服务验证（1.0.3）

- 服务随 start.js 启动（独立端口 8092，与 Web/引擎同进程），并在 `8090/api/mcp` 提供同源代理入口；
- Token 自动生成并保存在 `var/config.json` 的 `mcp.token`，LibreTV 设置页可查看/复制/重新生成/启停；
- 实测（1.0.3，NAS）：
  - `initialize` / `tools/list`（11 个工具）/ `resources/list` 正常；
  - `search_videos` 搜索《流浪地球》返回多源结果；
  - `add_to_library` 生成 `流浪地球 (2019)/流浪地球 (2019).strm`，索引 +1；
  - `list_library` / `get_strm_content` 正确返回条目与源 URL；
  - `remove_from_library` 删除 STRM、清理空目录、移除索引，文件与索引均清除；
  - `8090/api/mcp` 与 `8092/mcp` 两个入口均可用；
  - 设置页关闭 MCP 后请求立即 403，重新启用后恢复；
  - 应用重启后 8090/8091/8092 与 MCP token 均保持；
  - stdio 桥接 `mcp/stdio-bridge.js` 实测可完成 initialize/tools/list。
- 安全：Bearer Token 鉴权；删除仅限 STRM 根目录内且被索引引用的文件；Token 可随时重置。
- 限制：FN Connect 中继只暴露 fnOS 主网关，8090/8092 在中继下不可达，MCP 请在局域网/公网直连环境使用。
