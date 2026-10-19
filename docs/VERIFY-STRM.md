# STRM 播放链路验证（飞牛影视 0.9.8-1）

> 执行者：nas-verify｜日期：2026-10-19｜目标：验证「写入 .strm → 媒体端识别 → 播放时重定向/直链」链路
> 结论速览：**媒体端自动识别 STRM = 已验证通过**；**播放时 302 重定向 = 未观测到（被媒体服务端 DirectLinkPullError 阻断）**，需用户/管理员在影视端手动点击验证。

---

## 1. 测试环境与临时文件

- NAS：192.168.1.100，fnOS 1.2.0800，飞牛影视 `trim.media 0.9.8-1`（端口 8005，网关 5666/5667，`file_monitor=1`）。
- 测试用媒体库：电影库 `c94038bf70b14aa4abdc74ad957ca367` = `/vol2/1000/电影/`（用户已有库，只新增临时子目录）。
- 临时文件（均在 `_libretv_test/` 内，**未触碰用户任何媒体文件**）：

| 路径 | 内容 | 状态 |
|---|---|---|
| `/vol2/1000/电影/_libretv_test/Test (2024).strm` | 单行 m3u8 绝对 URL（换过 4 个测试源，见 §3） | 当前保留，供用户在影视端点击验证；验证后删除 |
| `_libretv_test/` 目录 | 临时目录 | 同上 |

写入命令（实测）：

```bash
D="/vol2/1000/电影/_libretv_test"
mkdir -p "$D"
printf '%s\n' "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" > "$D/Test (2024).strm"
chmod 644 "$D/Test (2024).strm"
```

先验证测试流从 NAS 可达（NAS 本机 curl）：

```
$ curl -sI -m 15 https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 | head
HTTP/2 200
content-type: application/vnd.apple.mpegurl   （另有 audio/mpegurl / application/x-mpegURL 的候选流均 200）
```

---

## 2. 媒体端识别 STRM：✅ 已验证（秒级，无需手动扫描）

写入目录后**无需触发扫描**，媒体文件监控立即发现并入库。`trim-media.log` 原始证据：

```
time="2026-10-19T11:22:10+08:00" level=info msg="dir /vol2/1000/电影/_libretv_test created and walk files to scrap."
time="2026-10-19T11:22:10+08:00" level=info msg="notify file path : , /vol2/1000/电影/_libretv_test/Test (2024).strm"
time="2026-10-19T11:22:10+08:00" level=info msg="scraper full run start" filePath="/vol2/1000/电影/_libretv_test/Test (2024).strm" mdbGuid=c94038bf70b14aa4abdc74ad957ca367
time="2026-10-19T11:22:10+08:00" level=info msg="strm file using virtual hash: 04bf193df634c6eb9643784f3322d022e0ca834b902701e273799cbd1cb7c65d"
time="2026-10-19T11:22:13+08:00" level=info msg="strm file scrap completed, skip stream task (will extract on play)"
```

数据库证据（只读查询 `trimmedia.db`）：

```
item_media:
  guid           = e929d47e4c314c43a5ed9b8bac121082
  item_guid      = ed9bc82a5469468db9dc5d47db966b5f
  dir            = /vol2/1000/电影/_libretv_test
  path           = /vol2/1000/电影/_libretv_test/Test (2024).strm
  size           = 50
  can_play       = 1
  type           = 1
  recognition_status = 2
  file_hash      = 04bf193df634c6eb9643784f3322d022e0ca834b902701e273799cbd1cb7c65d
```

**结论**：`file_monitor=1` 会在目录创建/文件写入后 **≤数秒**自动刮削，STRM 被识别为可播放媒体（can_play=1），**应用无需调用 API 触发扫描**（API 扫描仍建议作为配置变更后的兜底）。
副作用：`Test (2024)` 被刮削成错误影片 `人生对抗赛 (tm1112417)` —— 媒体按标题模糊匹配，应用生成文件名时应避免歧义（用完整片名+年份，必要时加唯一后缀）。

---

## 3. 播放链路 / 302：⚠️ 未观测到（服务端拉流失败）

### 3.1 播放 API（已打通签名，见 NAS-RECON.md §4）

播放调用链（由媒体 Web 前端 `static/assets/74c95...js` 反推）：

1. `POST /v/api/v1/play/play`，body 至少含 `{item_guid, media_guid, video_guid, ts}` → 响应 `data.play_link`。
2. 播放器再请求 `GET /v/api/v1/media/range/<media_guid>?playlink=<play_link>`（`M2()` 拼接）。
3. 直链模式（`direct_link_enable=1`）下播放器对该 URL **不带 Authorization 头**，即期望该 URL 自身完成重定向/直链播放。

实测 `media/range/<strm 的 media_guid>` 直接返回 **HTTP 400 + 空 body**，日志：

```
time="2026-10-19T11:27:47+08:00" level=warning msg="strm file range request not supported"
```

### 3.2 实际调用 `play/play` 的结果

```
POST /v/api/v1/play/play
body: {"item_guid":"ed9bc82a...","media_guid":"e929d47e...","video_guid":"ca33412d...","ts":0}
→ HTTP 200，{"msg":"","code":68157465,"data":null}
```

`trim-media.log`（服务端确实读到了 .strm 内的 URL）：

```
time="2026-10-19T11:33:01+08:00" level=info msg="strm file play, url: https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" method=PlayItem
time="2026-10-19T11:33:05+08:00" level=error msg="get play link error ... Errno:68157465 ..." method=PlayItem
```

`/usr/trim/logs/mediasrv.log`（系统媒体服务拉流时 ffmpeg 失败）：

```
[10-19 11:33:05.586] [error] av_find_best_stream(video) error
[10-19 11:33:05.591] [error] [ffmpeg] errno -1381258232, msg 'Stream not found'
```

错误码含义（从前端 bundle 反查）：`68157465 = DirectLinkPullError`（直链拉流失败），非权限错误（权限错误是 `-7015 NoPermissionDirectLinkStrm`）。

### 3.3 换源复测（排除单一源问题）

| 测试源 | NAS curl | play/play 结果 |
|---|---|---|
| `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`（master） | 200 | code 68157465 |
| `https://test-streams.mux.dev/pts_shift/master.m3u8`（master） | 200 | code 68157465 |
| `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8`（master） | 200 | code 68157465 |
| `https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8`（media playlist） | **403**（源不可用，测试无效） | code 8192（SystemInternalError） |

3 个可用源全部 `DirectLinkPullError`，mediasrv 侧均报 `av_find_best_stream(video) error / Stream not found`。共同点：三者均为 **HLS master playlist**。

### 3.4 结论与判断

- **已确认**：媒体端识别 STRM、读取 .strm 中的 URL、并尝试服务端拉流（日志 `strm file play, url: ...`）。
- **未确认（唯一未自动化项）**：播放时的 `302 → 源 URL` 未观测到。当前链路在 `play/play` 阶段即失败，播放器拿不到 `play_link`，因此**没有产生 302 响应**。
- **可能原因（按可能性排序，均待验证）**：
  1. mediasrv 的 ffmpeg 无法解析 **HLS master playlist**（只支持 media playlist/单码率 m3u8，或需先转封装）。→ 用真实 CMS 源的单码率 m3u8 或直链 mp4 再测。
  2. mediasrv 拉流需要特定网络条件/代理（NAS 本机 curl 可达，但 mediasrv 进程可能走不同网络路径）。
  3. 影视 0.9.8-1 的 STRM 直链播放存在已知限制/需在影视设置中开启「直链播放」（`direct_link_enable=1` 已开，但 `direct_link_allowed_level=0`、`direct_link_allowed_drives=''`，其语义未验证）。
- **不影响应用侧功能**：LibreTV 生成 STRM 的正确性已由「媒体识别 + 服务端读到 URL」证明；播放能否成功取决于影视端对源 URL 的处理，应用无法干预。

---

## 4. 后续需人工完成的一步（唯一未自动化项）

建议由用户在**飞牛影视 Web（192.168.1.100:5666）或 TV/手机 App** 中操作：

1. 打开「影视 → 电影」，找到 `_libretv_test` 下被刮削为「人生对抗赛 / Test (2024)」的条目（如未显示，在影视设置里对该库点一次「扫描/刷新」）。
2. 点击播放，观察是否开始播放；同时在 NAS 上观察：
   ```bash
   sudo -n tail -f /usr/local/apps/@appdata/trim.media/logs/trim-media.log | grep -i strm
   sudo -n tail -f /usr/trim/logs/mediasrv.log
   sudo -n tail -f /usr/trim/nginx/logs/access.log | grep -E "302|play"
   ```
3. 若播放成功，`access.log` 中应出现 `302`（Location 为源 URL）或播放器直连源站；若仍失败，把 mediasrv.log 错误一并反馈。

> 注：当前 `.strm` 内容为 `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8`（NAS curl 200）。若人工测试仍报拉流失败，请替换为真实可用的单码率 m3u8 再试。

---

## 5. 清理（验证完成后执行）

```bash
# 只删本次临时目录，不动用户任何媒体
rm -rf "/vol2/1000/电影/_libretv_test"
```

清理后媒体端会自动把该条目标记删除/清理（`file_monitor=1`）；如需立即生效，在影视 UI 对该库点一次「扫描」。
本次侦察在 NAS 上留下的其它临时文件（均可安全删除）：

- `/tmp/nv-db.py`、`/tmp/nv-db2.py`、`/tmp/nv-mask.py`、`/tmp/nv-api.py`、`/tmp/nv-api2.py`、`/tmp/nv-api3.py`、`/tmp/nv-api4.py`、`/tmp/nv-api5.py`、`/tmp/nv-final.py`、`/tmp/nv-q.py`、`/tmp/nv-q2.py`
- 未在 `/vol2/1000/liberTV` 创建任何内容；未修改任何媒体库配置/用户文件。

---

## 6. 风险提示

- 测试写入的是**用户真实媒体库**下的临时子目录（经用户授权），清理时务必只删 `_libretv_test`，不要删除 `/vol2/1000/电影` 下其它内容。
- 媒体刮削会把测试文件当成真实影片并下载海报/元数据（本次已产生一条错误影片记录），清理后应随之移除。
- 应用运行时写入的 `.strm` 若位于用户媒体库，同样会被刮削；建议 STRM 根目录用独立目录（如 `/vol2/1000/liberTV/strmdata`）并在影视中单独建库，便于管理与清理。
