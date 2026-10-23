# LibreTV-fnOS 上架飞牛应用商店：调研与提交清单

> 调研日期：2026-10-23
> 适用版本：LibreTV-fnOS 1.0.11（送审包已构建）
> 上架入口：[飞牛先锋开发者应用上架申请（飞书表单）](https://trim-nas.feishu.cn/share/base/form/shrcn9ewk59TfoFWVAPMPy6aWSc)
> 官方文档：[上架应用](https://developer.fnnas.com/docs/quick-started/publish-application/) · [统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration) · [Manifest](https://developer.fnnas.com/docs/core-concepts/manifest) · [测试应用](https://developer.fnnas.com/docs/quick-started/test-application/)

---

## 1. 结论（TL;DR）

1. **飞牛目前没有公开的自助开发者后台**，官方上架通道是这份飞书表单（官方文档也写明：开发者后台上线前，通过应用中心开发者先锋交流群提交）。
2. **审核通过后不是立即公开**：先自动进入内测组内测，**满一周后开放公测**。
3. 我们的应用**大部分满足**表单硬性要求：非 root、3 段版本号、名称不以“飞牛”开头、路径校验、无付费。
4. **1.0.11 已完成送审前 P0 改造**：
   - **端口鉴权**：8091 影视代理已复用 LibreTV 的 `ltv_session` 会话鉴权，未登录 302 跳回 8090，登录后正常；
   - **Manifest 开发者信息**：已改为 HarmonyRun、补 GitHub 地址与 `changelog`、移除废弃 `arch`；
   - **截图/隐私说明**：已准备 5 张真实截图与 `docs/PRIVACY.md`；
   - **商店版 OTA**：store edition 默认关闭应用内 OTA，更新走应用中心；社区版保留 OTA。
5. **最大不确定项是内容合规**：应用本身不内置片源，但功能是聚合第三方 CMS 资源生成 STRM；官方审核是否接受此类“影视资源聚合/媒体库工具”无法保证。建议按“媒体库管理工具”定位送审，同时准备社区商店作为备选。

**当前状态**：1.0.11 送审包已构建并实机验证（8091 鉴权、自愈看护、数据保留）；下一步是填飞书表单 + 上传 FPK/截图。

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
| 2 | 鉴权优先接入**飞牛统一网关**，不要监听公网端口；如必须监听端口，**需有自己的鉴权机制，不可免鉴权访问** | 8090 有 LibreTV 密码；**8091 已复用同一 `ltv_session` 会话鉴权**（未登录 302→8090）；8092 Bearer Token；8093 仅本机 | ✅ 端口均有应用层鉴权；未接统一网关，按“必要时监听端口+自有鉴权”路径送审 |
| 3 | platform=x86/arm/all；提交前自己验证可安装可运行 | manifest `platform=x86`，已在 x86 fnOS 1.2.0800 实测 | ✅（仅 x86；ARM 用户不可用） |
| 4 | 文件读写接口需校验路径，避免路径穿越 | 引擎 `buildPlan`/清理/MCP 删除均做 `isInside(strmRoot)`；媒体代理只读取索引内路径 | ✅ 基本满足；建议补自动化安全测试 |
| 5 | 个人开发者可付费，但首行声明付费、功能范围、体验期，且与飞牛无关 | 完全免费，无付费内容 | ✅ 不适用 |
| 6 | 版本号固定 3 段式 `x.y.z`；4 段无效 | `1.0.10` 是 3 段 | ✅ |
| 7 | 应用名称不得以“飞牛”为前缀 | `LibreTV 影视库` | ✅ |

---

## 4. 1.0.11 送审改造结果

### 已完成

| 项目 | 结果 |
|---|---|
| 8091 应用层鉴权 | 复用 LibreTV `ltv_session` Cookie；未登录 302 到 8090，登录后 200；HLS/WebSocket 同样校验 |
| Manifest 元数据 | `maintainer/distributor=HarmonyRun`，补 GitHub 地址、`changelog`，删除废弃 `arch` |
| 版本号 | 1.0.11（3 段式） |
| 商店版 OTA | `edition=store` 时默认不启动更新服务；社区版 `edition=community` 保持 OTA |
| 隐私说明 | 新增 `docs/PRIVACY.md` |
| 截图 | 5 张真实 UI（`docs/app-store/screenshots/`，Token/账号已脱敏） |
| 自愈看护 | 1.0.10 功能保留，送审版同样生效 |
| 干净安装/数据 | NAS 实机安装 1.0.11 通过，索引/STRM 保留 |

### 送审包

| 项目 | 值 |
|---|---|
| 文件 | `dist/app-store-submission/libretv-1.0.11-store.fpk` |
| 大小 | 约 51 MB |
| SHA256 | `05f3cee5cb40bf4a4bdf68f16bb3f636fc4e5f854a57a5df3dad78941f59e2b9` |
| edition | `store`（应用内 OTA 默认关闭） |

社区版（GitHub Release）：`v1.0.11`，`libretv-1.0.11.fpk`，SHA256 `f2518799466e24875b4ebe67392a9a6dec4a8741140cebc60731b024ec3ba036`。

### 仍需注意

1. **未接入统一网关**：目前按表单“如必须监听端口需有自己的鉴权机制”路径，8090/8091/8092 均有鉴权；若审核坚持统一网关，需要后续做 `/app/libretv` 网关注册（Next basePath + 影视代理路径改写，工作量较大）。
2. **8091 鉴权依赖同主机名 Cookie**：用户需先在 `http://<NAS>:8090` 登录，再从同一主机名打开 8091；这是正常使用路径。
3. **x86 only**：ARM 设备无法安装；如需覆盖 ARM，需另构建 arm64 FPK。
4. **内容合规风险**：官方审核是否接受“第三方资源聚合/媒体库工具”无法保证；备选社区商店。

## 5. 表单填写草稿

> `<...>` 为需要你补的内容；其余可直接使用。

| 字段 | 建议填写 |
|---|---|
| 应用名称 | `LibreTV 影视库` |
| 系统 | `fnOS` |
| 版本号 | `1.0.11` |
| 上架类型 | `新应用上架` |
| 开发者 | `LibreSpark/LibreTV（开源原项目，https://github.com/LibreSpark/LibreTV）；飞牛封装维护：HarmonyRun（https://github.com/HarmonyRun/LibreTV-fnOS）` |
| 发布者 | `<你的微信群名 / 昵称>` |
| 微信昵称/联系方式 | `<你的微信号或手机号>` |
| 应用详情页截图 | 上传 `dist/app-store-submission/screenshots.zip`（5 张） |
| 平台 | `x86` |
| fpk 文件 | `dist/app-store-submission/libretv-1.0.11-store.fpk` |
| 备注 | 见下方文案 |

**备注文案（可直接改）：**

```text
LibreTV 影视库是开源 LibreTV 的飞牛 fnOS 原生封装：
在 LibreTV 中搜索资源 → 详情页「加入媒体库」→ 自动生成 .strm 文本文件，
由飞牛影视扫描后以海报墙呈现；支持自动追更、空资源目录回收、
影视兼容播放代理、MCP 管理与应用内异常自愈。

安全与权限：
- 以应用用户 libretv 运行，不使用 root；
- 8090 使用 LibreTV 密码登录；8091 复用同一登录会话鉴权；
  8092 MCP 使用 Bearer Token；8093 仅监听 127.0.0.1；
- 所有文件操作限制在用户授权的 STRM 根目录内，拒绝路径穿越；
- 不内置任何片源，采集源由用户自行配置；数据仅保存在本地。

开源与许可：基于 LibreSpark/LibreTV（AGPL-3.0）二次开发，
源代码：https://github.com/HarmonyRun/LibreTV-fnOS
本次为首次上架，版本 1.0.11（商店版默认关闭应用内 OTA，更新走应用中心）。
```

## 6. 送审材料清单

- [x] 最终 FPK：`libretv-1.0.11-store.fpk`（manifest 版本一致、3 段）
- [x] 应用图标：64/256 PNG
- [x] 应用截图 5 张：`screenshots/` + `screenshots.zip`
- [x] 应用介绍/隐私说明：`PRIVACY.md`
- [x] 非 root 证明：`config/privilege` + 运行进程用户
- [x] 端口鉴权说明 + 8091 改造（实机验证 302/200）
- [x] 路径安全说明/已有审计
- [x] 干净安装/数据保留测试（1.0.11 NAS 实机）
- [x] 开源许可与上游 attribution（AGPL-3.0）
- [ ] 发布者/微信联系方式（需你填写）
- [ ] 飞书表单提交

## 7. 时间线与后续维护

1. ~~修复 P0 → 构建 1.0.11 → 实机回归~~（已完成）；
2. **下一步：填飞书表单**（上传 store FPK + 截图，填写发布者/微信）；
3. 官方审核；
4. 审核通过 → 自动推送到内测组 → **内测满一周** → 开放公测；
5. 后续更新：表单选择「应用更新」/「应用包替换」，提升 3 段版本号，附 changelog；
6. 商店版更新走应用中心，应用内 OTA 默认关闭；社区版继续用 GitHub OTA。

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
