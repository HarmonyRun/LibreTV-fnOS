# 应用内 OTA 自动更新（1.0.7+）

LibreTV-fnOS 会自行检查 GitHub Releases，发现新版本时在页面顶部显示「更新 vX」按钮；
点击后自动完成：下载 → sha256 校验 → 替换运行载荷 → 自动重启（失败自动回滚）。
配置、STRM 索引、媒体库数据全部保留。

## 工作方式

1. 应用启动 15 秒后检查一次，之后每 6 小时检查 GitHub Releases（`HarmonyRun/LibreTV-fnOS`）；
2. 更新资产：Release 中的 `libretv-update-<版本>.tar.gz`，用 GitHub API 的 `sha256:` digest 校验；
3. 下载使用 GitHub API 资产地址（会 302 到 `objects.githubusercontent.com`），避开 github.com 直连不稳定；
4. 解压到 `target/server.new-<ver>`，校验 `start.js`、`server.js`、`.next`、`node_modules/next` 与版本号；
5. 原子替换 `target/server`，保留 `target/server.old-<旧版本>`；
6. 通过 `cmd/main` 重启；重启脚本健康检查失败会**自动回滚**到旧版本。

> 更新只替换运行载荷（Next 前端 + STRM 引擎 + MCP + 自更新器），不会修改应用中心安装记录、
> `var/` 配置、STRM 文件与飞牛影视媒体库。

## 更新提醒与操作

- 顶部导航出现「更新 vX」橙色按钮，点击查看更新说明与「立即更新」；
- 更新完成后页面自动刷新；
- 若更新后异常：应用内会把旧版本保存在 `target/server.old-<旧版本>`，
  可将该目录改回 `target/server` 后重启（或用应用中心重装 FPK 恢复）。

## 与飞牛应用中心的区别

- OTA 更新后，**应用内版本**（设置/关于/MCP）为新版本；
- **飞牛应用中心显示的版本号**仍是你安装 FPK 的版本（安装行为不会因 OTA 改变）；
- 到应用中心安装新 FPK 会覆盖回该 FPK 的版本，但 `var/` 数据保留；
- 1.0.3 及更早版本没有更新器，需要手动安装一次 1.0.7+；之后即可页面内一键更新。

## 配置（可选）

编辑 `var/config.json`：

```json
{
  "update": {
    "enabled": true,
    "intervalHours": 6,
    "repo": "HarmonyRun/LibreTV-fnOS"
  }
}
```

- `enabled: false` 关闭自动检查（顶部不再提示）；
- `intervalHours` 调整检查间隔；
- `repo` 可指向你自己的 fork（需同时上传 update 资产）。

## 安全

- 仅从 GitHub Releases 下载，并使用 release 资产 digest 做 sha256 校验；
- 更新进程以应用用户运行，只能写应用自身目录与 `var/`；
- 部署脚本会校验关键文件与版本号，失败回滚。
