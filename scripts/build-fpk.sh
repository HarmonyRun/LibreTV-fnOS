#!/usr/bin/env bash
# LibreTV fnOS FPK 构建脚本
#
# 流程：
#   1) 本地 Next standalone 构建（SKIP_BUILD=1 可复用已有 .next）
#   2) 组装 libretv-fpk/app/server（Next standalone + engine + start.js + static + public）
#   3) 准备内置 Node 22 linux-x64 运行时 libretv-fpk/app/node/bin/node（下载并缓存）
#   4) rsync 工程到 NAS，远端 fnpack build，取回 dist/libretv-<version>.fpk
#
# 常用开关：
#   SKIP_BUILD=1        复用已有 libretv/.next（不重新 npm run build）
#   SKIP_SYNC=1         只做本地组装，不推送 NAS / 不构建 fpk
#   SKIP_NAS_BUILD=1    只推送工程到 NAS，不执行 fnpack build
#   SKIP_NODE_DOWNLOAD=1 复用已有 app/node/bin/node
#   MISSING_ENGINE_FATAL=1  engine 缺失时直接失败（最终集成时使用）
#   NODE_VERSION=22.20.0   内置 Node 版本
#   REMOTE_BASE=/vol2/1000/liberTV/build  远端构建根目录
#
# 依赖：node/npm、curl、tar(xz)、rsync、sshpass、file
#
# 本机实测（fnOS 1.2.0800 / x86_64 / Debian 12，2026-10-19）：
#   - `fnpack build` 在 NAS 上执行，输出文件名为 `<appname>.fpk`（本应用为 libretv.fpk），
#     脚本会重命名为 dist/libretv-<version>.fpk；fnpack 会自动在 manifest 追加 checksum 行。
#   - fpk 结构：manifest / cmd/ / config/ / wizard/ / ICON*.PNG / app.tgz
#     （app/ 被打成 app.tgz，内含 node/bin/node、server/、ui/）。
#   - 内置 Node：v22.20.0 linux-x64 官方二进制，解压后约 117MB（未 strip，含调试信息）。
#   - 载荷体积：app/server ≈ 48MB（删 node_modules/sharp 与 @img 后），
#     app/node ≈ 117MB，最终 fpk ≈ 52MB（gzip）。
#   - rsync 排除规则必须锚定传输根（前导 /）：`--exclude 'dist'` 会误伤
#     app/server/node_modules/next/dist，导致安装后 Next 启动报
#     "Cannot find module .../node_modules/next/dist/server/next.js"。
#     脚本在推送后校验远端 node_modules/next 文件数（应 >1000）再打包。
#   - 远端构建目录：/vol2/1000/liberTV/build/libretv-fpk（root 执行 fnpack build）。
#   - SSH：使用 scripts/ssh.sh（串行锁 + 真实退出码）；rsync 走 sshpass + ControlMaster。
#   - 开关：SKIP_BUILD / SKIP_SYNC / SKIP_NAS_BUILD / SKIP_NODE_DOWNLOAD / MISSING_ENGINE_FATAL。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRETV_DIR="$ROOT_DIR/libretv"
FPK_DIR="$ROOT_DIR/libretv-fpk"
DIST_DIR="$ROOT_DIR/dist"
CACHE_DIR="$ROOT_DIR/.cache"
APP_SERVER="$FPK_DIR/app/server"
APP_NODE="$FPK_DIR/app/node"

NODE_VERSION="${NODE_VERSION:-22.20.0}"
NODE_DIST_NAME="node-v${NODE_VERSION}-linux-x64"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST_NAME}.tar.xz"

SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_SYNC="${SKIP_SYNC:-0}"
SKIP_NAS_BUILD="${SKIP_NAS_BUILD:-0}"
SKIP_NODE_DOWNLOAD="${SKIP_NODE_DOWNLOAD:-0}"
MISSING_ENGINE_FATAL="${MISSING_ENGINE_FATAL:-0}"

SSH_WRAPPER="$ROOT_DIR/scripts/ssh.sh"
SSH_CONF="${FEINIU_CONF:-$HOME/.dsh/skills/飞牛SSH连接/feiniu.conf}"

# ---- 日志 -------------------------------------------------------------------
info() { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build][warn]\033[0m %s\n' "$*" >&2; }
die() {
    printf '\033[1;31m[build][error]\033[0m %s\n' "$*" >&2
    exit 1
}
step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
human_size() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖命令: $1"; }

# rsync 认证失败自动退避重试（ssh 认证限流时仍可完成推送/取回）
rsync_retry() {
    local attempt=1 max="${RSYNC_RETRIES:-3}"
    while :; do
        if sshpass -p "$REMOTE_PASS" rsync "$@"; then
            return 0
        fi
        if [ "$attempt" -ge "$max" ]; then
            return 1
        fi
        warn "rsync 失败，${RSYNC_BACKOFF:-30}s 后重试（${attempt}/$((max - 1))）"
        sleep "${RSYNC_BACKOFF:-30}"
        attempt=$((attempt + 1))
    done
}

# ---- 0. 基础检查 ------------------------------------------------------------
step "0/5 环境检查"
need_cmd node
need_cmd npm
need_cmd curl
need_cmd tar
need_cmd file
[ -d "$LIBRETV_DIR" ] || die "找不到 libretv 源码目录: $LIBRETV_DIR"
[ -f "$FPK_DIR/manifest" ] || die "找不到 FPK 工程 manifest: $FPK_DIR/manifest"
[ -f "$LIBRETV_DIR/start.js" ] || die "找不到 start.js: $LIBRETV_DIR/start.js"

APP_VERSION="$(awk -F'=' '/^[[:space:]]*version[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "$FPK_DIR/manifest" 2>/dev/null || true)"
[ -n "${APP_VERSION:-}" ] || APP_VERSION="1.0.0"
info "LibreTV FPK 版本: ${APP_VERSION}"

# ---- 1. Next standalone 构建 -----------------------------------------------
step "1/5 构建 Next standalone（DOCKER_BUILD=1）"
if [ "$SKIP_BUILD" = "1" ]; then
    [ -f "$LIBRETV_DIR/.next/standalone/server.js" ] || die "SKIP_BUILD=1 但缺少 .next/standalone/server.js，请先完整构建"
    info "已跳过构建，复用现有 .next/standalone"
else
    if [ ! -d "$LIBRETV_DIR/node_modules" ]; then
        info "安装依赖: npm ci"
        (cd "$LIBRETV_DIR" && npm ci)
    fi
    info "执行: DOCKER_BUILD=1 npm run build"
    (cd "$LIBRETV_DIR" && DOCKER_BUILD=1 npm run build)
fi
[ -f "$LIBRETV_DIR/.next/standalone/server.js" ] || die "构建产物缺少 .next/standalone/server.js"
[ -d "$LIBRETV_DIR/.next/static" ] || die "构建产物缺少 .next/static"
[ -d "$LIBRETV_DIR/public" ] || die "缺少 public 目录"

# ---- 2. 组装 app/server -----------------------------------------------------
step "2/5 组装 app/server"
rm -rf "$APP_SERVER"
mkdir -p "$APP_SERVER"

info "复制 .next/standalone"
cp -R "$LIBRETV_DIR/.next/standalone/." "$APP_SERVER/"

info "复制 .next/static 与 public"
mkdir -p "$APP_SERVER/.next"
rm -rf "$APP_SERVER/.next/static"
cp -R "$LIBRETV_DIR/.next/static" "$APP_SERVER/.next/static"
rm -rf "$APP_SERVER/public"
cp -R "$LIBRETV_DIR/public" "$APP_SERVER/public"

info "复制 start.js 与 package.json"
cp "$LIBRETV_DIR/start.js" "$APP_SERVER/start.js"
cp "$LIBRETV_DIR/package.json" "$APP_SERVER/package.json"

if [ -f "$LIBRETV_DIR/engine/index.js" ]; then
    info "复制 MCP 服务 mcp/"
    if [ -d "$LIBRETV_DIR/mcp" ]; then
        rm -rf "$APP_SERVER/mcp"
        cp -R "$LIBRETV_DIR/mcp" "$APP_SERVER/mcp"
    else
        warn "缺少 libretv/mcp：MCP 功能不可用"
    fi

    info "复制自更新服务 updater/"
    if [ -d "$LIBRETV_DIR/updater" ]; then
        rm -rf "$APP_SERVER/updater"
        cp -R "$LIBRETV_DIR/updater" "$APP_SERVER/updater"
    else
        warn "缺少 libretv/updater：OTA 自更新不可用"
    fi

    info "复制影视兼容代理 mediaserver/"
    if [ -d "$LIBRETV_DIR/mediaserver" ]; then
        rm -rf "$APP_SERVER/mediaserver"
        cp -R "$LIBRETV_DIR/mediaserver" "$APP_SERVER/mediaserver"
    else
        warn "缺少 libretv/mediaserver：影视兼容代理不可用"
    fi

    info "复制 STRM 引擎 engine/"
    rm -rf "$APP_SERVER/engine"
    cp -R "$LIBRETV_DIR/engine" "$APP_SERVER/engine"
else
    if [ "$MISSING_ENGINE_FATAL" = "1" ]; then
        die "缺少 libretv/engine/index.js（最终集成构建必须包含引擎）"
    fi
    warn "缺少 libretv/engine/index.js：本次 fpk 可构建，但运行时 STRM 引擎不可用（等待 engine-dev 完成后重新构建）"
fi

# 精简：删除 macOS 原生模块与缓存（linux 运行时不需要，Lead 已验证可安全删除）
info "精简 node_modules（sharp/@img、缓存、.DS_Store）"
rm -rf "$APP_SERVER/node_modules/sharp" "$APP_SERVER/node_modules/@img"
rm -rf "$APP_SERVER/node_modules/.cache"
rm -rf "$APP_SERVER/.next/cache"
find "$APP_SERVER" -name '.DS_Store' -type f -delete 2>/dev/null || true
find "$APP_SERVER" -name '*.DS_Store' -type f -delete 2>/dev/null || true

[ -f "$APP_SERVER/server.js" ] || die "组装失败：app/server/server.js 不存在"
[ -d "$APP_SERVER/node_modules/next" ] || die "组装失败：app/server/node_modules/next 不存在"
printf '{"name":"LibreTV-fnOS","version":"%s","builtAt":"%s"}\n' "${APP_VERSION}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP_SERVER/version.json"

info "app/server 大小: $(human_size "$APP_SERVER")"

# 归一化打包权限：cmd 可执行、配置/素材可读；避免源文件 600 权限带入 fpk
info "归一化文件权限"
chmod 755 "$FPK_DIR"/cmd/* 2>/dev/null || true
chmod 755 "$APP_NODE/bin/node" 2>/dev/null || true
chmod 644 "$FPK_DIR"/manifest "$FPK_DIR"/ICON*.PNG "$FPK_DIR"/config/* "$FPK_DIR"/wizard/* 2>/dev/null || true
chmod 644 "$FPK_DIR"/app/ui/config "$FPK_DIR"/app/ui/images/*.png 2>/dev/null || true
find "$APP_SERVER" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$APP_SERVER" -type f -exec chmod 644 {} + 2>/dev/null || true

# ---- 3. 内置 Node 运行时 ----------------------------------------------------
step "3/5 准备内置 Node 运行时（linux-x64）"
mkdir -p "$APP_NODE/bin" "$CACHE_DIR/node"
TARBALL="$CACHE_DIR/node/${NODE_DIST_NAME}.tar.xz"

if [ "$SKIP_NODE_DOWNLOAD" = "1" ] && [ -x "$APP_NODE/bin/node" ]; then
    info "已跳过下载，复用 app/node/bin/node"
else
    if [ ! -f "$TARBALL" ]; then
        info "下载 ${NODE_URL}"
        curl -fL --retry 3 --retry-delay 2 -o "${TARBALL}.tmp" "$NODE_URL" || die "Node 运行时下载失败"
        mv "${TARBALL}.tmp" "$TARBALL"
    else
        info "使用缓存: $TARBALL"
    fi
    TMP_EXTRACT="$(mktemp -d "${TMPDIR:-/tmp}/libretv-node.XXXXXX")"
    tar -xJf "$TARBALL" -C "$TMP_EXTRACT" "${NODE_DIST_NAME}/bin/node" || die "解压 Node 运行时失败"
    cp "$TMP_EXTRACT/${NODE_DIST_NAME}/bin/node" "$APP_NODE/bin/node"
    rm -rf "$TMP_EXTRACT"
    chmod 755 "$APP_NODE/bin/node"
fi

[ -f "$APP_NODE/bin/node" ] || die "缺少 app/node/bin/node"
FILE_DESC="$(file -b "$APP_NODE/bin/node" 2>/dev/null || true)"
case "$FILE_DESC" in
*ELF*64-bit*x86-64* | *ELF*64-bit*AMD*x86-64*) info "Node 二进制校验通过: $FILE_DESC" ;;
*) die "app/node/bin/node 不是 linux x86-64 ELF: $FILE_DESC" ;;
esac

if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
    NODE_VER_OK="$("$APP_NODE/bin/node" --version 2>/dev/null || true)"
    [ -n "$NODE_VER_OK" ] || die "内置 Node 无法执行 --version"
    info "内置 Node 可执行: $NODE_VER_OK"
else
    info "当前宿主非 linux-x64，跳过 --version 执行校验（将由 NAS 安装后验证）"
fi
info "app/node 大小: $(human_size "$APP_NODE")"

# ---- 4. 体积报告 ------------------------------------------------------------
step "4/5 本地载荷体积"
info "libretv-fpk 总计: $(human_size "$FPK_DIR")"
info "  app/server: $(human_size "$APP_SERVER")"
info "  app/node:   $(human_size "$APP_NODE")"
info "  app/ui:     $(human_size "$FPK_DIR/app/ui")"
info "  cmd/config/wizard/manifest: $(human_size "$FPK_DIR/cmd") + $(human_size "$FPK_DIR/manifest")"

if [ "$SKIP_SYNC" = "1" ]; then
    step "完成（SKIP_SYNC=1，未推送 NAS）"
    info "本地组装完成: $FPK_DIR"
    exit 0
fi

# ---- 5. 推送 NAS 并 fnpack build -------------------------------------------
step "5/5 推送 NAS 并执行 fnpack build"
[ -x "$SSH_WRAPPER" ] || die "SSH 包装器不可执行: $SSH_WRAPPER（请 chmod +x）"
need_cmd sshpass

# 读取连接配置（环境变量优先，其次 feiniu.conf）
_ENV_HOST="${FEINIU_HOST:-}"
_ENV_PORT="${FEINIU_PORT:-}"
_ENV_USER="${FEINIU_USER:-}"
_ENV_PASS="${FEINIU_PASS:-}"
if [ -f "$SSH_CONF" ]; then
    # shellcheck disable=SC1090
    . "$SSH_CONF"
fi
[ -n "$_ENV_HOST" ] && FEINIU_HOST="$_ENV_HOST"
[ -n "$_ENV_PORT" ] && FEINIU_PORT="$_ENV_PORT"
[ -n "$_ENV_USER" ] && FEINIU_USER="$_ENV_USER"
[ -n "$_ENV_PASS" ] && FEINIU_PASS="$_ENV_PASS"
REMOTE_HOST="${FEINIU_HOST:-192.168.1.100}"
REMOTE_PORT="${FEINIU_PORT:-23}"
REMOTE_USER="${FEINIU_USER:-test}"
REMOTE_PASS="${FEINIU_PASS:-}"
REMOTE_BASE="${REMOTE_BASE:-/vol2/1000/liberTV/build}"
REMOTE_DIR="${REMOTE_DIR:-$REMOTE_BASE/libretv-fpk}"
[ -n "$REMOTE_PASS" ] || die "缺少 FEINIU_PASS（检查 $SSH_CONF 或环境变量）"

KNOWN_HOSTS_FILE="$HOME/.dsh/skills/飞牛SSH连接/.known_hosts"
RSYNC_SSH="ssh -F /dev/null -p ${REMOTE_PORT} -o ControlMaster=auto -o ControlPath=/tmp/libretv-ssh-mux -o ControlPersist=300 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS_FILE} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o LogLevel=ERROR"
REMOTE_TARGET="${REMOTE_USER}@${REMOTE_HOST}"

info "远端目录: ${REMOTE_HOST}:${REMOTE_DIR}"
info "准备远端构建目录"
"$SSH_WRAPPER" -r "mkdir -p '${REMOTE_DIR}' && chown ${REMOTE_USER} '${REMOTE_DIR}' && chmod 775 '${REMOTE_DIR}' && echo REMOTE_READY" || die "远端目录准备失败"

step "rsync 推送工程"
# 排除规则必须锚定传输根目录（前导 /），否则 --exclude 'dist' 会误伤
# node_modules/next/dist 等依赖目录，导致安装后 Next 无法启动
RSYNC_EXCLUDES=(--exclude '/.DS_Store' --exclude '/dist' --exclude '/.cache' --exclude '*.tmp' --exclude '/node_modules/.cache')
rsync_retry -az --delete "${RSYNC_EXCLUDES[@]}" \
    -e "$RSYNC_SSH" "$FPK_DIR/" "${REMOTE_TARGET}:${REMOTE_DIR}/" || die "rsync 推送失败"
info "推送完成"

# 完整性校验：Next standalone 依赖 node_modules/next/dist，缺失会导致安装后启动失败
REMOTE_NEXT_COUNT="$("$SSH_WRAPPER" "find '${REMOTE_DIR}/app/server/node_modules/next' -type f 2>/dev/null | wc -l" | tr -d '\r ' | head -n 1)"
if [ -z "${REMOTE_NEXT_COUNT:-}" ] || [ "${REMOTE_NEXT_COUNT}" -lt 800 ] 2>/dev/null; then
    die "远端推送不完整：node_modules/next 文件数=${REMOTE_NEXT_COUNT:-未知}（应 >1000），请检查 rsync 排除规则"
fi
info "远端载荷校验通过：node_modules/next 文件数 ${REMOTE_NEXT_COUNT}"

if [ "$SKIP_NAS_BUILD" = "1" ]; then
    step "完成（SKIP_NAS_BUILD=1，未构建 fpk）"
    exit 0
fi

step "远端 fnpack build"
BUILD_OUT=""
if ! BUILD_OUT="$("$SSH_WRAPPER" -r "cd '${REMOTE_DIR}' && rm -f ./*.fpk && fnpack build" 2>&1)"; then
    printf '%s\n' "$BUILD_OUT"
    die "远端 fnpack build 失败"
fi
printf '%s\n' "$BUILD_OUT"
case "$BUILD_OUT" in
*"Packing successfully"*) info "fnpack build 成功" ;;
*) warn "fnpack 输出未包含成功标记，继续检查产物" ;;
esac

REMOTE_FPK="$("$SSH_WRAPPER" "ls -1t '${REMOTE_DIR}'/*.fpk 2>/dev/null | head -n 1" | tr -d '\r' | head -n 1)"
[ -n "$REMOTE_FPK" ] || die "远端未找到 .fpk 产物"
info "远端产物: ${REMOTE_FPK}"

step "生成本地更新包（OTA payload）"
mkdir -p "$DIST_DIR"
UPDATE_TGZ="$DIST_DIR/libretv-update-${APP_VERSION}.tar.gz"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$UPDATE_TGZ" -C "$APP_SERVER" --exclude './var' --exclude './.DS_Store' . 2>/dev/null \
    || COPYFILE_DISABLE=1 tar -czf "$UPDATE_TGZ" -C "$APP_SERVER" --exclude './var' --exclude './.DS_Store' .
info "更新包: ${UPDATE_TGZ}（$(human_size "${UPDATE_TGZ}")，SHA256 $(shasum -a 256 "${UPDATE_TGZ}" | awk '{print $1}')）"

step "取回 fpk 到 dist/"
mkdir -p "$DIST_DIR"
rsync_retry -az -e "$RSYNC_SSH" "${REMOTE_TARGET}:${REMOTE_FPK}" "$DIST_DIR/" || die "fpk 取回失败"

LOCAL_FPK="$DIST_DIR/$(basename "$REMOTE_FPK")"
FINAL_FPK="$DIST_DIR/libretv-${APP_VERSION}.fpk"
if [ "$LOCAL_FPK" != "$FINAL_FPK" ]; then
    rm -f "$FINAL_FPK"
    mv -f "$LOCAL_FPK" "$FINAL_FPK"
fi
[ -f "$FINAL_FPK" ] || die "本地 fpk 不存在: $FINAL_FPK"

FILE_FPK="$(file -b "$FINAL_FPK" 2>/dev/null || true)"
SHA_FPK="$(shasum -a 256 "$FINAL_FPK" 2>/dev/null | awk '{print $1}' || true)"

step "构建完成"
info "FPK: $FINAL_FPK"
info "大小: $(human_size "$FINAL_FPK") ($(wc -c <"$FINAL_FPK") bytes)"
info "类型: $FILE_FPK"
info "SHA256: $SHA_FPK"
info "远端产物: ${REMOTE_HOST}:${REMOTE_FPK}"
info "下一步: ./scripts/deploy.sh   （安装到 /vol2 并启动健康检查）"
