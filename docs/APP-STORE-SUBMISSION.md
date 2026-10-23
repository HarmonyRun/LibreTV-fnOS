# LibreTV-fnOS 上架飞牛应用商店：调研与提交清单

> 调研日期：2026-10-23
> 适用版本：LibreTV-fnOS 1.0.10（送审建议重建 1.0.11）
> 上架入口：[飞牛先锋开发者应用上架申请（飞书表单）](https://trim-nas.feishu.cn/share/base/form/shrcn9ewk59TfoFWVAPMPy6aWSc)
> 官方文档：[上架应用](https://developer.fnnas.com/docs/quick-started/publish-application/) · [统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration) · [Manifest](https://developer.fnnas.com/docs/core-concepts/manifest) · [测试应用](https://developer.fnnas.com/docs/quick-started/test-application/)

---

## 1. 结论（TL;DR）

1. **飞牛目前没有公开的自助开发者后台**，官方上架通道是这份飞书表单（官方文档也写明：开发者后台上线前，通过应用中心开发者先锋交流群提交）。
2. **审核通过后不是立即公开**：先自动进入内测组内测，**满一周后开放公测**。
3. 我们的应用**大部分满足**表单硬性要求：非 root、3 段版本号、名称不以“飞牛”开头、路径校验、无付费。
4. **送审前必须补的短板**：
   - **端口鉴权**：8091 影视代理目前没有应用层鉴权（依赖飞牛影视登录），表单明确要求“监听端口需有自己的鉴权机制，不可免鉴权访问”；
   - **Manifest 开发者信息**：目前 `maintainer/distributor=fpk-dev` 是占位，缺 `maintainer_url`、`distributor_url`、`changelog`，还有已废弃的 `arch` 字段；
   - **截图/隐私说明**：表单要求真实应用截图；需要补隐私政策说明；
   - **应用内 OTA 与商店更新策略冲突**：官方商店通常要求通过商店更新；送审版本建议默认关闭 GitHub OTA（或仅保留检查提示），避免审核认为绕过商店。
5. **最大不确定项是内容合规**：应用本身不内置片源，但功能是聚合第三方 CMS 资源生成 STRM；官方审核是否接受此类“影视资源聚合/媒体库工具”无法保证。建议按“媒体库管理工具”定位送审，同时准备社区商店作为备选。

**建议路线**：先做 1.0.11「送审版」修复 P0 项 → 填表提交 → 内测一周 → 公测。

---

## 2. 官方上架流程（按表单与文档）

### 2.1 提交前

1. 准备通过 `fnpack build` 生成的最终 `.fpk`；
2. 准备应用图标、真实应用截图（表单截图“不会显示到应用中心”，仅审核用）；
3. 在计划支持的环境（fnOS 版本 + 硬件架构）完成安装/运行/核心流程测试；
4. 自查表单“提交前自查”7 条（见第 3 节）。

### 2.2 进入开发者通道

官方文档流程：

1. 加入任意飞牛粉丝群（从 [飞牛官网](https://fnnas.com/) 右上角关注飞牛 → 微信群）；
2. 在群内联系飞牛社区主理人，加入 **应用中心开发者先锋交流群**；
3. 按工作人员指引提交应用信息、应用包和测试材料。

表单本身可直接打开填写；如需反馈进度，表单要求填写发布者/微信联系方式。

### 2.3 提交表单

表单标题：**飞牛先锋开发者应用上架申请**
表单字段（必填项）：

| 字段 | 说明 |
|---|---|
| 应用名称 | 不能以“飞牛”为前缀 |
| 系统 | fnOS / Fygo 国际版 |
| 版本号 | 必须与 FPK manifest 一致，3 段式 |
| 上架类型 | 新应用上架 / 应用更新 / 应用包替换 |
| 开发者 | 开源项目填原开发者信息 |
| 发布者 | 群名称或微信号/手机号等，便于反馈审核进度 |
| 微信昵称/联系方式 | 便于联系 |
| 应用详情页截图 | 真实 UI，审核用，不展示到应用中心 |
| 平台 | x86 / arm / x86 和 arm |
| fpk 文件 | x86/arm 分包则上传两个 |
| 备注 | 初次上架描述功能，更新描述变更 |

提交后：**审核 → 自动进入内测组 → 内测满一周 → 开放公测**。没进内测组可找官方群客服添加。

---

## 3. 表单“提交前自查”7 条 vs 我们现状

| # | 官方要求（表单原文要点） | 我们现状 | 结论/行动 |
|---|---|---|---|
| 1 | **root 权限应用无法上架**，会直接忽略 | `config/privilege` 为 `run-as=package`，生命周期脚本以应用用户运行 | ✅ 满足，保留证据 |
| 2 | 鉴权优先接入**飞牛统一网关**，不要监听公网端口；如必须监听端口，**需有自己的鉴权机制，不可免鉴权访问** | 8090 有 LibreTV 密码；8092 有 Bearer Token；8093 仅本机；**8091 影视代理无应用层鉴权**（依赖影视登录） | ⚠️ **送审前必须处理 8091**；建议也评估网关接入 |
| 3 | platform=x86/arm/all；提交前自己验证可安装可运行 | manifest `platform=x86`，已在 x86 fnOS 1.2.0800 实测 | ✅（仅 x86；ARM 用户不可用） |
| 4 | 文件读写接口需校验路径，避免路径穿越 | 引擎 `buildPlan`/清理/MCP 删除均做 `isInside(strmRoot)`；媒体代理只读取索引内路径 | ✅ 基本满足；建议补自动化安全测试 |
| 5 | 个人开发者可付费，但首行声明付费、功能范围、体验期，且与飞牛无关 | 完全免费，无付费内容 | ✅ 不适用 |
| 6 | 版本号固定 3 段式 `x.y.z`；4 段无效 | `1.0.10` 是 3 段 | ✅ |
| 7 | 应用名称不得以“飞牛”为前缀 | `LibreTV 影视库` | ✅ |

---

## 4. 我们应用的差距清单（按优先级）

### P0：送审前必须处理

1. **8091 应用层鉴权**
   - 现状：`mediaserver` 监听 `0.0.0.0:8091`，直接把飞牛影视 Web 反向代理出来；未登录用户也能打开影视登录页/静态资源，部分接口依赖影视自己的 Cookie。
   - 建议：校验 LibreTV 的 `ltv_session` Cookie（与 8090 同一 HMAC 会话，Cookie 不区分端口，8091 可直接复用）：
     - 无有效会话 → 302 跳转 `http://<host>:8090/` 或返回 401；
     - 有会话 → 正常代理；`/__strm/<HMAC token>` 继续保留 token 校验。
   - 这样 8090/8091 都有应用层鉴权，8092 有 Token，8093 仅本机，可向审核说明“所有对外端口均有鉴权”。
   - 可选进阶：把 8090/8091 注册到飞牛统一网关（`gatewayPrefix=/app/libretv` + Unix Socket），彻底不监听公网端口；工作量较大，可作为后续版本。

2. **Manifest 元数据**
   - 当前 `maintainer=fpk-dev`、`distributor=fpk-dev` 是占位；
   - 缺 `maintainer_url`、`distributor_url`、`changelog`；
   - `arch` 字段已被官方文档标记为废弃（改用 `platform`），建议删除；
   - 建议改为：
     ```ini
     maintainer            = HarmonyRun
     maintainer_url        = https://github.com/HarmonyRun/LibreTV-fnOS
     distributor           = HarmonyRun
     distributor_url       = https://github.com/HarmonyRun/LibreTV-fnOS
     changelog             = 1.0.11: 增加端口鉴权、完善应用元数据与隐私说明
     platform              = x86
     # 删除 arch = x86_64
     ```
   - 版本号改为 1.0.11（3 段），送审包与表单版本一致。

3. **应用内 OTA 与商店更新策略**
   - 现状：应用会检查 GitHub Releases 并允许一键替换运行载荷；官方商店通常要求更新走商店审核。
   - 建议送审版默认 `update.enabled=false`（或仅“检查更新”提示，不自动下载），在应用介绍中说明“商店版更新由应用中心提供”；社区/侧载版可保留 OTA。
   - 若保留 OTA，需在备注中主动说明更新来源与校验机制，但仍有审核风险。

4. **截图与隐私说明**
   - 表单要求真实应用截图；已准备 5 张（`docs/app-store/screenshots/`，可打包上传）：
     - 首页、搜索结果、详情页「加入媒体库」、STRM 设置、MCP 面板；
   - 截图中的 MCP Token/媒体账号已脱敏；私有 IP 可保留（审核环境可见），建议进一步替换为 `<NAS-IP>` 更稳妥；
   - 补一份隐私说明（本地保存哪些数据、访问哪些外部服务：CMS 源站、GitHub、飞牛影视 API），放进 README/应用介绍。

### P1：提高通过率

5. **应用描述与定位**
   - 避免“影视聚合/免费看片”等表述；定位为“自建媒体库管理工具 / STRM 生成器”，明确：
     - 不内置、不提供任何片源；
     - 用户自行配置采集源；
     - 仅用于技术学习与研究；
     - 遵守当地版权法规。
   - 但需注意：功能本身涉及第三方源，审核仍可能以内容合规拒绝，无法保证。

6. **干净环境测试**
   - 全新 fnOS（建议 1.2.0800）x86 安装到 `/vol2`；
   - 断网启动（应能打开登录/设置，不崩溃）；
   - 搜索 → 加入媒体库 → 飞牛影视扫描 → 播放（LAN/公网 8091；中继原生）；
   - MCP 初始化/搜索/删除；OTA 关闭状态；
   - 卸载：确认用户 STRM 不被删除；重装保留 `var`；
   - 检查无 root 进程：`ps -o user,pid,cmd -C node` 应为 `libretv`。

7. **路径穿越与权限测试**
   - 构造 `strmRoot` 指向 `/`、`../`、符号链接；应拒绝或限制在授权目录；
   - MCP `remove_from_library` 指定根目录外路径；应拒绝；
   - 8091 未登录访问；应跳转/401。

8. **图标与桌面入口**
   - 当前 `ICON.PNG` 64×64、`ICON_256.PNG` 256×256、`ui/images/icon_64/256` 均存在；符合常见要求；
   - `app/ui/config` 当前为端口入口（8090）；若后续接网关，改为 `gatewayPrefix/gatewaySocket`。

### P2：后续增强

9. **ARM 支持**：当前仅 x86；如需覆盖 ARM 设备，需要增加 arm64 Node 运行时与独立 FPK，表单可分开提交 x86/arm 两个包。
10. **统一网关**：进一步满足“优先接入统一网关”，去掉公网端口；需要处理 Next basePath/影视代理绝对路径，工作量较大。

---

## 5. 表单填写草稿

> `<...>` 为需要你补的内容；其余可直接使用。

| 字段 | 建议填写 |
|---|---|
| 应用名称 | `LibreTV 影视库` |
| 系统 | `fnOS` |
| 版本号 | `1.0.11`（与送审 FPK manifest 一致） |
| 上架类型 | `新应用上架` |
| 开发者 | `LibreSpark/LibreTV（开源原项目，https://github.com/LibreSpark/LibreTV）；飞牛封装维护：HarmonyRun（https://github.com/HarmonyRun/LibreTV-fnOS）` |
| 发布者 | `<你的微信群名 / 昵称>` |
| 微信昵称/联系方式 | `<你的微信号或手机号>` |
| 应用详情页截图 | 上传 `docs/app-store/screenshots/` 内 5 张（或 `screenshots.zip`） |
| 平台 | `x86` |
| fpk 文件 | `dist/libretv-1.0.11.fpk` |
| 备注 | 见下方文案 |

**备注文案（可直接改）：**

```text
LibreTV 影视库是开源 LibreTV 的飞牛 fnOS 原生封装：
在 LibreTV 中搜索资源 → 详情页「加入媒体库」→ 自动生成 .strm 文本文件，
由飞牛影视扫描后以海报墙呈现；支持自动追更、空资源目录回收、
影视兼容播放代理、MCP 管理与应用内异常自愈。

安全与权限：
- 以应用用户 libretv 运行，不使用 root；
- 8090 使用 LibreTV 密码登录；8091 在送审版本中复用同一登录会话鉴权；
  8092 MCP 使用 Bearer Token；8093 仅监听 127.0.0.1；
- 所有文件操作限制在用户授权的 STRM 根目录内，拒绝路径穿越；
- 不内置任何片源，采集源由用户自行配置；数据仅保存在本地。

开源与许可：基于 LibreSpark/LibreTV（AGPL-3.0）二次开发，
源代码：https://github.com/HarmonyRun/LibreTV-fnOS
本次为首次上架，版本 1.0.11。
```

---

## 6. 送审材料清单

- [ ] 最终 FPK：`dist/libretv-1.0.11.fpk`（manifest 版本一致、3 段）
- [ ] 应用图标：64/256 PNG（已有）
- [ ] 应用截图 5 张：`docs/app-store/screenshots/`
- [ ] 应用介绍/隐私说明（README 或单独文档）
- [ ] 非 root 证明：`config/privilege` + 运行进程用户
- [ ] 端口鉴权说明 + 8091 改造成果
- [ ] 路径安全说明/测试记录
- [ ] 安装/升级/卸载测试记录（干净 fnOS）
- [ ] 开源许可与上游 attribution
- [ ] 发布者/微信联系方式

---

## 7. 时间线与后续维护

1. 修复 P0（建议 1–2 天）→ 构建 1.0.11 → 干净环境回归；
2. 填飞书表单提交 → 官方审核；
3. 审核通过 → 自动推送到内测组 → **内测满一周** → 开放公测；
4. 公测反馈修复 → 正式上架（以官方实际流程为准）；
5. 后续更新：表单选择「应用更新」/「应用包替换」，提升 3 段版本号，附 changelog；
6. 应用内 OTA 与商店更新并存时，明确“商店版以应用中心更新为准”，避免用户困惑。

---

## 8. 备选分发渠道

如果官方审核周期较长或因内容合规被拒，可先走社区商店：

- **fnOS Apps（第三方社区商店）**：<https://github.com/conversun/fnos-apps>，收录 175+ 第三方 `.fpk`，通过 GitHub PR/Issue 提交；
- 自托管 GitHub Releases（我们已有）+ 社区群分发。

社区商店不是官方商店，但可作为过渡曝光渠道；官方上架后仍建议保留 GitHub Release 作为侧载与回滚通道。

---

## 9. 参考资料

- 飞书表单：<https://trim-nas.feishu.cn/share/base/form/shrcn9ewk59TfoFWVAPMPy6aWSc>
- 官方上架文档：<https://developer.fnnas.com/docs/quick-started/publish-application/>
- 统一网关：<https://developer.fnnas.com/docs/core-concepts/gateway-registration>
- Manifest：<https://developer.fnnas.com/docs/core-concepts/manifest>
- 测试应用：<https://developer.fnnas.com/docs/quick-started/test-application/>
- 社区应用仓库：<https://github.com/conversun/fnos-apps>

> 说明：以上流程/要求来自 2026-10-23 的官方文档与飞书表单；官方后续可能上线开发者后台并调整流程，提交前请再核对表单与文档。
