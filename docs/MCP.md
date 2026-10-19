# MCP 服务（用大模型管理 LibreTV / 飞牛影视库）

1.0.3 起，LibreTV-fnOS 内置 **MCP（Model Context Protocol）** 服务，DeepSeek Harness、
WorkBuddy 等支持 MCP 的 AI 客户端可以直接：

- 搜索采集站影视资源
- 把资源加入飞牛影视库（自动生成 STRM、触发媒体库扫描）
- 查看已入库条目
- 删除某个影视剧的 STRM 文件并清理索引
- 触发增量同步 / 孤儿清理 / 媒体库扫描

所有写操作复用应用内现有队列与索引，不绕过引擎；MCP 服务异常不影响 LibreTV 主 Web。

## 1. 启用与获取 Token

打开 LibreTV → 设置 → 媒体库 → STRM 媒体库 → 底部 **「MCP 服务（大模型接入）」**：

- 可查看/复制访问令牌（默认随应用自动生成）；
- 可「重新生成」令牌（旧令牌立即失效）；
- 可启用/禁用 MCP。

## 2. 连接地址

| 地址 | 适用场景 |
|---|---|
| `http://<NAS-IP>:8092/mcp` | LAN / 公网直连；MCP 独立端口 |
| `http://<NAS-IP>:8090/api/mcp` | 只能访问 LibreTV Web 端口时（同源代理） |

鉴权 Header：

```
Authorization: Bearer <MCP_TOKEN>
```

> FN Connect / 中继只转发 fnOS 主网关，`8090/8092` 在中继下不可达；远程使用 MCP 需要
> 公网端口映射或局域网。中继观看本身使用飞牛影视原生直连，不依赖 MCP。

## 3. MCP 客户端配置

### HTTP / Streamable HTTP 客户端（推荐）

```json
{
  "mcpServers": {
    "libretv": {
      "type": "http",
      "url": "http://192.168.1.100:8092/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

> 不同客户端字段名略有差异：`type` 可能写作 `transport`，值可能是 `http` 或
> `streamable-http`；按客户端文档选择，URL 与 Header 不变。

### 仅支持 stdio 的客户端

使用仓库自带桥接脚本（在本机运行，转发到 NAS）：

```bash
node mcp/stdio-bridge.js --url http://<NAS-IP>:8092/mcp --token <MCP_TOKEN>
```

客户端配置：

```json
{
  "mcpServers": {
    "libretv": {
      "command": "node",
      "args": [
        "/path/to/LibreTV-fnOS/mcp/stdio-bridge.js",
        "--url", "http://192.168.1.100:8092/mcp",
        "--token", "<MCP_TOKEN>"
      ]
    }
  }
}
```

## 4. 工具列表

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `search_videos` | 在采集站搜索资源 | `query`、`limit`、`sources?` |
| `get_video_detail` | 查看详情/线路/剧集（只读） | `sourceApiBase`、`vodId` |
| `add_to_library` | 加入影视库并生成 STRM | `sourceApiBase`、`vodId`、`type?`、`wait?` |
| `list_library` | 列出已入库条目 | `query?`、`type?`、`limit?` |
| `remove_from_library` | 删除条目 + STRM + 索引 + 刷新影视库 | `key` 或 `title`、`all?`、`refreshMedia?` |
| `sync_library` | 触发增量同步 | `wait?`、`timeoutSeconds?` |
| `cleanup_orphans` | 清理孤儿 STRM | `wait?` |
| `get_engine_status` | 引擎/索引/同步状态 | — |
| `refresh_media_library` | 触发飞牛影视扫描 | `dirList?` |
| `list_sources` | 列出采集源 | — |
| `get_strm_content` | 读取条目的 STRM 源地址 | `key` 或 `title`、`limit?` |

资源（resources）：`libretv://library`、`libretv://status`、`libretv://sources`。

## 5. 典型对话示例

> 用户：帮我找《流浪地球》，挑一个资源加进影视库。
>
> 模型：`search_videos` → 选择结果 → `add_to_library`（wait=true）→ 返回生成的路径。

> 用户：把《庆余年》从影视库删掉。
>
> 模型：`list_library` 确认条目 → `remove_from_library`（title=庆余年，all=true 如需多源）→
> 返回删除的文件与媒体库刷新结果。

## 6. 安全说明

- 所有 MCP 请求必须携带 Bearer Token；Token 仅在登录 LibreTV 后可查看/重置；
- `remove_from_library` 只允许删除 **STRM 根目录内**、且被索引引用的 `.strm` 文件，
  不会递归删除用户其它文件；`all=false` 时匹配多条会要求确认；
- 令牌泄露时立即在设置页「重新生成」；
- MCP 服务默认启用；不需要可在设置页关闭。
