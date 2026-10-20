# LibreTV-fnOS MCP 接入操作文档

> 适用版本：LibreTV-fnOS **1.0.8 及以上**（MCP 服务于 1.0.3 引入，1.0.8 支持按资源目录/按季删除）
> 适用客户端：DeepSeek Harness、WorkBuddy、Claude Desktop、Cursor、其他支持 MCP 的 AI 客户端

---

## 1. 能力概览

接入后，AI 客户端可以调用以下工具管理 LibreTV / 飞牛影视库：

| 工具 | 作用 |
|---|---|
| `search_videos` | 在 LibreTV 配置的采集站搜索影视资源 |
| `get_video_detail` | 查看线路、剧集、季数等详情 |
| `add_to_library` | 加入影视库（生成 STRM、更新索引、触发影视扫描，与手动「加入媒体库」同一逻辑） |
| `list_library` | 列出已入库资源（含资源目录、季信息） |
| `remove_from_library` | 删除资源：默认递归删除整个资源目录；`season=N` 只删该季文件夹 |
| `sync_library` | 触发 STRM 增量同步 |
| `cleanup_orphans` | 清理孤儿 STRM 文件 |
| `refresh_media_library` | 手动触发飞牛影视扫描 |
| `get_engine_status` | 查看引擎/索引/同步状态 |
| `list_sources` | 列出采集源 |
| `get_strm_content` | 读取条目对应的 STRM 源地址（排障） |

另提供资源：`libretv://library`、`libretv://status`、`libretv://sources`。

MCP **不负责播放**：播放仍走 LibreTV 8090 / 影视兼容代理 8091 / 飞牛影视原生入口。

---

## 2. 前置条件

1. 飞牛上已安装并启动 **LibreTV-fnOS 1.0.8+**；
2. 客户端与 NAS 网络可达：
   - 局域网：直接使用 NAS 内网 IP；
   - 公网：需要能访问应用端口（8092 或 8090）；
   - ⚠️ **FN Connect / 飞牛中继只转发 fnOS 主网关，不转发 8090/8092**，中继下无法使用 MCP；
3. 知道 LibreTV 的访问密码（用于登录设置页获取 Token）。

---

## 3. 获取连接信息

1. 打开 LibreTV：`http://<NAS-IP>:8090`，登录；
2. 进入 **设置 → 媒体库 → STRM 媒体库**；
3. 拉到最下方 **「MCP 服务（大模型接入）」**：
   - 确认状态为「已启用」；
   - 复制 **访问令牌**（Token）；
   - 下面会显示两个连接地址。

| 连接地址 | 适用场景 |
|---|---|
| `http://<NAS-IP>:8092/mcp` | 推荐；MCP 独立端口，直接连接 |
| `http://<NAS-IP>:8090/api/mcp` | 只能访问 LibreTV Web 端口时使用（同源代理） |

鉴权 Header：

```
Authorization: Bearer <MCP_TOKEN>
```

> Token 泄露时，在设置页点「重新生成」立即失效；不需要 MCP 时可直接「已启用/已禁用」切换（无需重启）。

---

## 4. 接入方式 A：HTTP / Streamable HTTP（推荐）

LibreTV-fnOS 的 MCP 服务使用 **Streamable HTTP**（POST JSON-RPC 2.0，JSON 响应）。
绝大多数现代 MCP 客户端都支持。

### 4.1 通用配置（Claude / Cursor / 兼容 JSON 的客户端）

```json
{
  "mcpServers": {
    "libretv": {
      "type": "http",
      "url": "http://<NAS-IP>:8092/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

> 不同客户端字段名可能不同：
> - `type` 可能叫 `transport`，值是 `http` 或 `streamable-http`；
> - `headers` 可能叫 `httpHeaders`；
> - 少数客户端把 URL 和 Header 放在 UI 表单里。
> 核心只有两个：**URL** 和 **Authorization Bearer Token**。

### 4.2 DeepSeek Harness

1. 打开 DeepSeek Harness 的 **设置 / 扩展 / MCP Servers**（不同版本入口名称略有差异）；
2. 新增一个 **HTTP / Streamable HTTP** 类型的 Server：
   - Name：`libretv`
   - URL：`http://<NAS-IP>:8092/mcp`
   - Header：`Authorization: Bearer <MCP_TOKEN>`
3. 保存并启用；
4. 在会话里让它列出工具，或直接说「列一下我的影视库」。

> 如果 Harness 仅支持 stdio 类型，见第 5 节用桥接脚本。

### 4.3 WorkBuddy

1. 打开 WorkBuddy 的 **MCP / 工具连接器** 设置；
2. 添加 **HTTP MCP Server**；
3. 填写 URL 与 Header（同上）；
4. 保存后确认连接状态为已连接。

### 4.4 验证连通（可先不用客户端）

```bash
curl -s -X POST "http://<NAS-IP>:8092/mcp" \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

返回 `serverInfo.name = libretv-fnos` 即成功；再调用 `tools/list` 应返回 11 个工具。

---

## 5. 接入方式 B：stdio 桥接（仅支持 stdio 的客户端）

如果客户端只能启动本地命令（如 Claude Desktop 旧版），使用仓库自带桥接脚本：

1. 从 GitHub 下载 `mcp/stdio-bridge.js`：
   `https://github.com/HarmonyRun/LibreTV-fnOS/blob/main/libretv/mcp/stdio-bridge.js`
2. 本机安装 Node.js（18+）；
3. 客户端配置：

```json
{
  "mcpServers": {
    "libretv": {
      "command": "node",
      "args": [
        "/绝对路径/stdio-bridge.js",
        "--url", "http://<NAS-IP>:8092/mcp",
        "--token", "<MCP_TOKEN>"
      ]
    }
  }
}
```

或手动测试：

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"stdio","version":"1"}}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node stdio-bridge.js --url "http://<NAS-IP>:8092/mcp" --token "<MCP_TOKEN>"
```

---

## 6. 首次验证清单

在 AI 客户端里依次让它执行：

1. **列出工具**：应看到 `search_videos`、`add_to_library`、`remove_from_library` 等 11 个；
2. **查看状态**：`get_engine_status` → 返回当前版本、STRM 根目录、索引条目数；
3. **列出现有库**：`list_library` → 应能看到你已加入的影视条目（含 `resourceRoot`、`seasons`）；
4. **搜索测试**：`search_videos` 搜索一部影片 → 返回 `sourceApiBase` 与 `vodId`。

---

## 7. 常用操作示例

### 7.1 搜索并加入影视库

对 AI 说：

> 帮我搜索《庆余年》，选一个资源加入影视库，完成后告诉我路径。

模型实际调用顺序：

```json
{"tool":"search_videos","arguments":{"query":"庆余年","limit":5}}
{"tool":"add_to_library","arguments":{
  "sourceApiBase":"https://caiji.dyttzyapi.com/api.php/provide/vod",
  "vodId":"35200",
  "wait":true
}}
```

返回 `status=generated`、`strmPaths` 即成功；STRM 生成逻辑与网页手动「加入媒体库」完全一致。

### 7.2 删除整部剧（连同资源文件夹）

> 把《庆余年》从影视库删掉，整个文件夹一起删。

```json
{"tool":"remove_from_library","arguments":{"title":"庆余年"}}
```

效果：递归删除 `strmdata/庆余年 第一季 (2019)` 整个目录（含 nfo、海报、字幕等），
同步清理索引并刷新飞牛影视。

### 7.3 只删除某一季

> 只删《庆余年》第一季，第二季保留。

```json
{"tool":"remove_from_library","arguments":{"title":"庆余年","season":1}}
```

效果：只删除 `Season 01` 文件夹，`Season 02` 与索引中的第二季条目保留。

### 7.4 先预览再删

```json
{"tool":"remove_from_library","arguments":{"title":"庆余年","dryRun":true}}
```

返回将删除的目录、文件数，不实际删除。

### 7.5 其他维护

- 手动同步：`{"tool":"sync_library","arguments":{"wait":true}}`
- 清理孤儿：`{"tool":"cleanup_orphans","arguments":{"wait":true}}`
- 刷新影视库：`{"tool":"refresh_media_library","arguments":{}}`

---

## 8. 大模型提示词建议（可选）

在客户端里给 Agent 加一段系统提示：

```
你可以通过 libretv MCP 管理飞牛影视库。
规则：
1. 删除前先用 list_library 确认条目的 resourceRoot 和 seasons；
2. 用户说“删整部剧”时调用 remove_from_library(title)，会递归删除资源目录；
3. 用户说“只删第 N 季”时传 season=N；
4. 不确定时先传 dryRun=true 预览；
5. 添加资源必须先用 search_videos 获取 sourceApiBase 和 vodId，再调用 add_to_library；
6. 删除后报告 deletedDirs、removedEntries 和 refresh 结果。
```

---

## 9. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `401 Unauthorized` | Token 错误或 Header 不是 `Bearer`；到设置页重新复制/重置 Token |
| 连接 8092 超时 | 客户端与 NAS 网络不通、端口未放行；FN Connect 中继不转发 8090/8092，需局域网/公网直连 |
| 8092 不通但 8090 正常 | 改用 `http://<NAS-IP>:8090/api/mcp` |
| `502 MCP 服务不可用` | 应用内 MCP 进程未启动；应用中心重启 LibreTV 后重试（8093 为内部健康端口） |
| GET /mcp 返回 405 | 正常：服务只支持 POST（Streamable HTTP），不会影响正常客户端 |
| `tools/call` 返回“未找到匹配的条目” | 索引中没有该资源；先 `list_library`；手动放进 strmdata 的文件夹需先入库 |
| 删除后 refresh 报“未找到包含 STRM 根目录的媒体库” | 飞牛影视媒体库路径与 strmdata 不匹配；在飞牛影视中把媒体库指到该目录，文件监控也会兜底同步 |
| 添加后 `status=processing` | 引擎仍在生成，稍后 `list_library` 查看；大剧集可能超过 90 秒 |
| 更新后 Token 变化 | 不会变；只有手动「重新生成」或重装导致 config 丢失才变 |

---

## 10. 安全与限制

- MCP 使用 **Bearer Token** 鉴权；Token 等同于媒体库管理权限，请勿发到公开群/截图；
- `remove_from_library` 是**危险操作**：默认递归删除，删除前可用 `dryRun=true` 预览；
  服务只允许删除 `strmdata` 目录内的资源目录，拒绝根目录与目录外路径；
- 8092 为明文 HTTP；公网使用建议加 HTTPS 反向代理或仅通过 VPN/内网访问；
- FN Connect / 中继下 8090/8091/8092 不可达，MCP 不可用（远程观看不受影响）；
- MCP 只管理媒体库，不提供视频播放能力。

---

## 11. 附：最小 JSON-RPC 调用

初始化：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}
```

列工具：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

调用工具：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_library","arguments":{"limit":20}}}
```

成功响应中的 `result.structuredContent` 为结构化结果，`result.content[0].text` 为同内容的 JSON 文本。
