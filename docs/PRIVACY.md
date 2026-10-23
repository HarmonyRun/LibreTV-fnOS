# LibreTV-fnOS 隐私说明

> 适用版本：1.0.11
> 项目：https://github.com/HarmonyRun/LibreTV-fnOS

LibreTV-fnOS 是一个在飞牛 fnOS 本机运行的自托管媒体库管理工具。**应用不提供任何在线账号体系，不收集、不上传用户数据到开发者服务器，也没有遥测/统计 SDK。**

## 1. 本地保存的数据

以下数据仅保存在 NAS 本地 `var` 目录（默认 `/vol2/@appdata/libretv`）：

| 数据 | 用途 |
|---|---|
| LibreTV 访问密码（哈希/签名密钥派生） | 8090/8091 登录鉴权 |
| 采集源列表（用户自行配置） | 搜索影视资源 |
| 飞牛影视账号、密码、媒体库名称 | 触发飞牛影视扫描（可选） |
| MCP Token | 供用户自己的 AI 客户端连接 |
| `strm-index.json`、`state.json`、队列/日志 | 媒体库索引、同步状态、排障 |
| 更新备份 `server.old-*` | OTA 失败回滚（社区版） |

STRM 文件保存在用户授权的 STRM 根目录（如 `/vol2/1000/liberTV/strmdata`）。

## 2. 会访问的外部服务

| 服务 | 时机 | 数据 |
|---|---|---|
| 用户配置的 CMS 采集源 | 搜索/入库/同步时 | 只发送搜索关键词与资源 ID，不发送账号信息 |
| 源站 CDN（m3u8/分片） | 播放时 | 由客户端或 8091 代理直接请求，不经过开发者服务器 |
| 本机飞牛影视 API（`127.0.0.1:5666`） | 生成 STRM 后刷新媒体库 | 使用用户填写的飞牛影视账号登录 |
| GitHub Releases（仅社区版） | 更新检查（默认 6 小时） | 仅请求公开 Release 信息；商店版默认关闭 |
| GitHub / 镜像站 | 用户手动下载应用时 | 由用户浏览器发起 |

**没有开发者服务器、没有 analytics、没有崩溃上报。**

## 3. 端口、鉴权与访问范围

| 端口 | 用途 | 鉴权 |
|---|---|---|
| 8090 | LibreTV Web | 安装时设置的访问密码（`ltv_session` 签名 Cookie） |
| 8091 | 飞牛影视兼容代理 | **复用 8090 的 `ltv_session` 登录会话**；未登录访问会跳回 8090 |
| 8092 | MCP | `Authorization: Bearer <MCP Token>` |
| 8093 | 应用内更新服务 | 仅监听 `127.0.0.1` |

文件操作限制在用户授权的 STRM 根目录内，删除操作拒绝 `strmdata` 根目录和目录外路径；应用以非 root 用户 `libretv` 运行。

## 4. 数据删除

- 应用中心卸载默认**保留** `var` 与 STRM 文件；可在卸载向导中显式选择删除 STRM（二次确认）；
- 删除应用数据：停止应用后删除 `/vol2/@appdata/libretv`；
- 删除媒体库：删除 STRM 根目录，或在媒体库中删除条目后由空目录回收机制清理；
- MCP Token：在 LibreTV 设置页「重新生成」即刻使旧 Token 失效。

## 5. 联系方式

- 问题反馈：https://github.com/HarmonyRun/LibreTV-fnOS/issues
- 本项目基于 LibreSpark/LibreTV（AGPL-3.0）二次开发，详见仓库 LICENSE 与 README。
