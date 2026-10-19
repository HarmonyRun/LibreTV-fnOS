#!/usr/bin/env bash
# LibreTV fnOS FPK 部署脚本
#
# 功能：
#   1) 把 dist/libretv-<version>.fpk、向导变量 .env、远端安装脚本推送到 NAS
#   2) 若已安装则先卸载（SKIP_UNINSTALL=1 可跳过）
#   3) appcenter-cli install-fpk -v <volume> -e <env> 安装到指定卷（默认 2 = /vol2）
#   4) appcenter-cli start，随后轮询 127.0.0.1:8090/api/auth 健康检查
#   5) 失败时输出安装信息与 $TRIM_PKGVAR/app.log 等日志
#
# 本机实测（fnOS 1.2.0800 / x86_64 / Debian 12，2026-10-19）：
#   - 安装卷参数：`install-fpk <fpk> -v 2` → 安装到 /vol2（target=/vol2/@appcenter/libretv，
#     var=/vol2/@appdata/libretv）；default-volume 当前为 1（/vol1），所以必须显式 -v 2。
#   - 向导变量：`-e <file>`，文件格式是简单 dotenv（UTF-8 无 BOM、LF、无 export/引号），例如：
#         wizard_strm_root=/vol2/1000/liberTV/strmdata
#         wizard_password=libretv
#   - 同版本已安装时 `install-fpk` 只输出 "Application [libretv] is installed." 并跳过替换；
#     `appcenter-cli uninstall` 会提示 "please uninstall it from Web UI"（本应用含 wizard/uninstall）。
#     → 替换载荷必须升 manifest version 走 upgrade 路径，或在 Web UI 卸载后重装。
#   - install_* 回调以应用用户（非 root）执行，不能 chown/trimacl；目录写权限由
#     「应用中心 → 应用设置 → 授权目录」授予（fnOS 以 root 补 trimacl ACE）。
#     deploy.sh 默认在安装后用 root 预授权一次（PREGRANT_ACL=1）以方便自动化验证。
#   - 应用日志：/vol2/@appdata/libretv/app.log（= $TRIM_PKGVAR/app.log）；
#     安装器日志：/var/log/apps/libretv.log。
#
# 用法：
#   ./scripts/deploy.sh                          # 部署 dist 下最新 fpk 到 /vol2
#   ./scripts/deploy.sh path/to/libretv.fpk
#   DEPLOY_VOLUME=2 DEPLOY_STRM_ROOT=/vol2/1000/liberTV/strmdata ENV_FILE=deploy.env ./scripts/deploy.sh
#   SKIP_UNINSTALL=1 ./scripts/deploy.sh         # 覆盖安装（不先卸载）
#
# 环境变量：DEPLOY_VOLUME（默认 2）、DEPLOY_STRM_ROOT（默认 /vol2/1000/liberTV/strmdata）、
#           DEPLOY_PASSWORD（默认 libretv）、ENV_FILE（自定义向导变量文件）、
#           SKIP_UNINSTALL（1=不卸载）、SSH_CONF、FEINIU_* 连接参数
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
SSH_WRAPPER="$ROOT_DIR/scripts/ssh.sh"
SSH_CONF="${FEINIU_CONF:-$HOME/.dsh/skills/飞牛SSH连接/feiniu.conf}"

DEPLOY_VOLUME="${DEPLOY_VOLUME:-2}"
DEPLOY_STRM_ROOT="${DEPLOY_STRM_ROOT:-/vol2/1000/liberTV/strmdata}"
DEPLOY_PASSWORD="${DEPLOY_PASSWORD:-libretv}"
SKIP_UNINSTALL="${SKIP_UNINSTALL:-0}"
ENV_FILE="${ENV_FILE:-}"
PREGRANT_ACL="${PREGRANT_ACL:-1}"

info() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy][warn]\033[0m %s\n' "$*" >&2; }
die() {
    printf '\033[1;31m[deploy][error]\033[0m %s\n' "$*" >&2
    exit 1
}
step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

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

# ---- 0. 参数、依赖、连接配置 ------------------------------------------------
FPK="${1:-}"
if [ -z "$FPK" ]; then
    FPK="$(ls -1t "$DIST_DIR"/libretv-*.fpk 2>/dev/null | head -n 1 || true)"
fi
[ -n "$FPK" ] || die "未找到 fpk：请先运行 scripts/build-fpk.sh，或显式传入路径"
[ -f "$FPK" ] || die "fpk 不存在: $FPK"
FPK="$(cd "$(dirname "$FPK")" && pwd)/$(basename "$FPK")"

[ -x "$SSH_WRAPPER" ] || die "SSH 包装器不可执行: $SSH_WRAPPER（请 chmod +x）"
command -v sshpass >/dev/null 2>&1 || die "缺少 sshpass"
command -v rsync >/dev/null 2>&1 || die "缺少 rsync"

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
[ -n "$REMOTE_PASS" ] || die "缺少 FEINIU_PASS（检查 $SSH_CONF 或环境变量）"

KNOWN_HOSTS_FILE="$HOME/.dsh/skills/飞牛SSH连接/.known_hosts"
RSYNC_SSH="ssh -F /dev/null -p ${REMOTE_PORT} -o ControlMaster=auto -o ControlPath=/tmp/libretv-ssh-mux -o ControlPersist=300 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS_FILE} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o LogLevel=ERROR"
REMOTE_TARGET="${REMOTE_USER}@${REMOTE_HOST}"
REMOTE_STAGE="/tmp/libretv-deploy"
FPK_NAME="$(basename "$FPK")"
REMOTE_FPK="${REMOTE_STAGE}/${FPK_NAME}"
REMOTE_ENV="${REMOTE_STAGE}/libretv-install.env"
REMOTE_VARS="${REMOTE_STAGE}/deploy-vars.env"
REMOTE_SCRIPT="${REMOTE_STAGE}/deploy-remote.sh"

# ---- 向导变量文件（install-fpk 必需，dotenv 格式） --------------------------
TMP_WORK="$(mktemp -d "${TMPDIR:-/tmp}/libretv-deploy.XXXXXX")"
trap 'rm -rf "$TMP_WORK"' EXIT

if [ -z "$ENV_FILE" ]; then
    ENV_FILE="${TMP_WORK}/libretv-install.env"
    {
        printf 'wizard_strm_root=%s\n' "$DEPLOY_STRM_ROOT"
        printf 'wizard_password=%s\n' "$DEPLOY_PASSWORD"
    } >"$ENV_FILE"
    info "自动生成向导变量文件（wizard_strm_root / wizard_password）"
fi
[ -f "$ENV_FILE" ] || die "ENV_FILE 不存在: $ENV_FILE"

# 远端安装脚本（推送后在 NAS 上以 root 执行，避免本地 heredoc/引号问题）
cat >"$TMP_WORK/deploy-remote.sh" <<'REMOTE_EOF'
#!/bin/bash
# 由 scripts/deploy.sh 推送到 NAS 执行（root）
set -u
. /tmp/libretv-deploy/deploy-vars.env

APP="libretv"
APP_DIR="/vol${VOLUME}/@appcenter/${APP}"
VAR_DIR="/vol${VOLUME}/@appdata/${APP}"
set +e

echo "===HOSTINFO==="
id -u
echo "===CHECK_BEFORE==="
CHECK_BEFORE="$(appcenter-cli check "$APP" 2>&1)"
echo "$CHECK_BEFORE"
INSTALLED_BEFORE=yes
case "$CHECK_BEFORE" in
*"Not Installed"*) INSTALLED_BEFORE=no ;;
esac
echo "INSTALLED_BEFORE=$INSTALLED_BEFORE"

if [ "$INSTALLED_BEFORE" = "yes" ] && [ "$SKIP_UNINSTALL" != "1" ]; then
    echo "===UNINSTALL==="
    UNINSTALL_OUT="$(appcenter-cli uninstall "$APP" 2>&1)"
    echo "$UNINSTALL_OUT"
    echo "uninstall_rc=$?"
    case "$UNINSTALL_OUT" in
    *"Web UI"*) echo "UNINSTALL_BLOCKED=yes" ;;
    esac
    sleep 2
fi

echo "===CHECK_AFTER_UNINSTALL==="
CHECK_AFTER_UNINSTALL="$(appcenter-cli check "$APP" 2>&1)"
echo "$CHECK_AFTER_UNINSTALL"
INSTALLED_AFTER_UNINSTALL=yes
case "$CHECK_AFTER_UNINSTALL" in
*"Not Installed"*) INSTALLED_AFTER_UNINSTALL=no ;;
esac
echo "INSTALLED_AFTER_UNINSTALL=$INSTALLED_AFTER_UNINSTALL"

echo "===ENV_FILE==="
sed 's/=.*/=<set>/' "$ENV_FILE" 2>&1

echo "===INSTALL==="
INSTALL_OUT="$(appcenter-cli install-fpk "$FPK" -v "$VOLUME" -e "$ENV_FILE" 2>&1)"
echo "$INSTALL_OUT"
echo "install_rc=$?"
case "$INSTALL_OUT" in
*"is installed"*) echo "SAME_VERSION_SKIP=yes" ;;
esac

echo "===CHECK_AFTER==="
CHECK_AFTER="$(appcenter-cli check "$APP" 2>&1)"
echo "$CHECK_AFTER"
INSTALLED_AFTER=yes
case "$CHECK_AFTER" in
*"Not Installed"*) INSTALLED_AFTER=no ;;
esac
echo "INSTALLED_AFTER=$INSTALLED_AFTER"

echo "===PAYLOAD_CHECK==="
NEXT_COUNT="$(find "$APP_DIR/server/node_modules/next" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo "NEXT_COUNT=${NEXT_COUNT:-0}"
if [ "${NEXT_COUNT:-0}" -lt 800 ] 2>/dev/null; then
    echo "PAYLOAD_INCOMPLETE=yes"
else
    echo "PAYLOAD_INCOMPLETE=no"
fi

if [ "$INSTALLED_AFTER" != "yes" ]; then
    echo "===FAIL_INFO==="
    appcenter-cli list 2>&1 | grep -i -A3 "$APP"
    ls -la /var/apps/"$APP" 2>&1
    find /vol* -maxdepth 3 -name "$APP" -type d 2>/dev/null | head -5
    exit 1
fi

echo "===PREGRANT_ACL==="
APP_UID="$(id -u "$APP" 2>/dev/null || true)"
echo "APP_UID=${APP_UID:-none} STRM_ROOT=${STRM_ROOT:-none} PREGRANT_ACL=${PREGRANT_ACL:-1}"
if [ "${PREGRANT_ACL:-1}" = "1" ] && [ -n "$APP_UID" ] && [ -n "${STRM_ROOT:-}" ]; then
    mkdir -p "$STRM_ROOT" 2>&1
    echo "mkdir_rc=$?"
    if [ -x /usr/trim/bin/trimacl ]; then
        /usr/trim/bin/trimacl -m "a:u:${APP_UID}:rwxpDaAeEc:sfd" "$STRM_ROOT" 2>&1
        echo "trimacl_rc=$?"
    else
        echo "trimacl_missing=1"
    fi
    if su -s /bin/sh "$APP" -c "touch '$STRM_ROOT/.preflight' && rm -f '$STRM_ROOT/.preflight'" >/dev/null 2>&1; then
        echo "WRITE_TEST=OK"
    else
        echo "WRITE_TEST=FAIL"
        echo "===PREGRANT_ANCESTORS==="
        P="$(dirname "$STRM_ROOT")"
        DEPTH=0
        while [ -n "$P" ] && [ "$P" != "/" ] && [ "$DEPTH" -lt 5 ]; do
            case "$P" in
            /vol[0-9]*)
                /usr/trim/bin/trimacl -m "a:u:${APP_UID}:x:s" "$P" 2>&1
                echo "ancestor_ace=$P rc=$?"
                ;;
            esac
            P="$(dirname "$P")"
            DEPTH=$((DEPTH + 1))
        done
        if su -s /bin/sh "$APP" -c "touch '$STRM_ROOT/.preflight' && rm -f '$STRM_ROOT/.preflight'" >/dev/null 2>&1; then
            echo "WRITE_TEST_AFTER_ANCESTORS=OK"
        else
            echo "WRITE_TEST_AFTER_ANCESTORS=FAIL"
        fi
    fi
fi

echo "===START==="
appcenter-cli start "$APP"
echo "start_rc=$?"

echo "===HEALTH==="
OK=0
i=1
while [ "$i" -le 30 ]; do
    if curl -fsS --max-time 3 http://127.0.0.1:8090/api/auth >/dev/null 2>&1; then
        OK=1
        break
    fi
    sleep 2
    i=$((i + 1))
done
if [ "$OK" -eq 1 ]; then
    echo "HEALTH=OK"
else
    echo "HEALTH=FAIL"
fi

echo "===STATUS==="
appcenter-cli status "$APP"
echo "status_rc=$?"

echo "===INFO==="
appcenter-cli list 2>&1 | grep -i -A5 "$APP"
echo "===PATHS==="
ls -ld "$APP_DIR" 2>&1
ls -ld "$VAR_DIR" 2>&1
find /vol* -maxdepth 3 -name "$APP" -type d 2>/dev/null | head -5
echo "===VAR_FILES==="
ls -la "$VAR_DIR" 2>&1
echo "===PERM_MARKERS==="
cat "$VAR_DIR/perm-ok" 2>&1
cat "$VAR_DIR/perm-needed" 2>&1
echo "===APP_LOG_TAIL==="
tail -n 60 "$VAR_DIR/app.log" 2>&1
echo "===ENGINE_LOG_TAIL==="
tail -n 20 "$VAR_DIR/engine.log" 2>&1
echo "===ACL==="
if [ -x /usr/trim/bin/trimacl ]; then
    /usr/trim/bin/trimacl "${STRM_ROOT:-/vol2/1000/liberTV/strmdata}" 2>&1 | head -20
else
    echo "trimacl not found"
fi
exit 0
REMOTE_EOF

cat >"$TMP_WORK/deploy-vars.env" <<EOF
FPK="${REMOTE_FPK}"
ENV_FILE="${REMOTE_ENV}"
VOLUME="${DEPLOY_VOLUME}"
SKIP_UNINSTALL="${SKIP_UNINSTALL}"
STRM_ROOT="${DEPLOY_STRM_ROOT}"
PREGRANT_ACL="${PREGRANT_ACL}"
EOF

info "本地 FPK: $FPK ($(du -h "$FPK" | awk '{print $1}'))"
info "目标: ${REMOTE_HOST}:${REMOTE_STAGE}/${FPK_NAME}，安装卷 /vol${DEPLOY_VOLUME}"
info "STRM 根目录: ${DEPLOY_STRM_ROOT}"

# ---- 1. 推送 fpk / env / 安装脚本 -------------------------------------------
step "1/3 推送 fpk 与安装脚本到 NAS"
"$SSH_WRAPPER" "mkdir -p '${REMOTE_STAGE}'" || die "创建远端暂存目录失败"
rsync_retry -az -e "$RSYNC_SSH" \
    "$FPK" "${TMP_WORK}/deploy-remote.sh" "${TMP_WORK}/deploy-vars.env" \
    "${REMOTE_TARGET}:${REMOTE_STAGE}/" || die "rsync 推送失败"
rsync_retry -az -e "$RSYNC_SSH" --ignore-times "$ENV_FILE" "${REMOTE_TARGET}:${REMOTE_ENV}" || die "推送向导变量失败"
"$SSH_WRAPPER" -r "chmod 644 '${REMOTE_ENV}' '${REMOTE_FPK}'; chmod 755 '${REMOTE_SCRIPT}'; echo STAGE_READY" || die "准备远端暂存目录失败"
info "推送完成"

# ---- 2. 远端安装 / 启动 / 健康检查 ------------------------------------------
step "2/3 远端安装并启动"
DEPLOY_OUT=""
DEPLOY_RC=0
if DEPLOY_OUT="$("$SSH_WRAPPER" -r "bash '${REMOTE_SCRIPT}'" 2>&1)"; then
    DEPLOY_RC=0
else
    DEPLOY_RC=$?
fi
printf '%s\n' "$DEPLOY_OUT"

# ---- 3. 结果判定 ------------------------------------------------------------
step "3/3 结果"

# 仅提示，不做任何破坏性动作（不删向导/应用目录；替换载荷请升版本或走 Web UI）
case "$DEPLOY_OUT" in
*"UNINSTALL_BLOCKED=yes"*)
    warn "appcenter-cli 无法卸载已安装应用：输出要求从 Web UI 卸载（本应用含 wizard/uninstall）"
    warn "自动化替换载荷请升 manifest version 走 upgrade 路径（保留 var）；deploy.sh 不会删除任何应用文件"
    ;;
esac

case "$DEPLOY_OUT" in
*"SAME_VERSION_SKIP=yes"*)
    warn "检测到同版本已安装：appcenter-cli 输出 \"Application [libretv] is installed.\" 并跳过替换"
    warn "已安装载荷未被更新（target 仍是旧包）"
    warn "处理方式（二选一）："
    warn "  1) 升 manifest version（如 1.0.1）后重新构建，install-fpk 会走 upgrade 路径替换载荷并保留 var"
    warn "  2) 在「应用中心 → LibreTV → 卸载」从 Web UI 卸载后再安装"
    warn "注意：本应用含 wizard/uninstall，appcenter-cli uninstall 会被拒绝（提示 Web UI）"
    exit 3
    ;;
*"INSTALLED_AFTER=yes"*) info "应用已安装（appcenter-cli check 通过）" ;;
*)
    warn "应用未安装成功"
    die "安装失败，详见上方输出与 NAS 上 /vol${DEPLOY_VOLUME}/@appdata/libretv/app.log 及 /var/log/apps/libretv.log"
    ;;
esac

case "$DEPLOY_OUT" in
*"PAYLOAD_INCOMPLETE=yes"*)
    warn "安装载荷不完整：node_modules/next 文件数 < 800（Next 将启动失败）"
    warn "检查 build-fpk.sh 的 rsync 排除规则（--exclude 'dist' 会误伤 node_modules/next/dist）"
    exit 4
    ;;
esac

HEALTH_FAIL=0
case "$DEPLOY_OUT" in
*"HEALTH=OK"*) info "远端 127.0.0.1:8090/api/auth 健康检查通过" ;;
*)
    HEALTH_FAIL=1
    warn "远端健康检查失败（进程/端口未就绪）"
    ;;
esac

# 安装路径/卷核验：从 INFO 段解析
INSTALL_PATH="$(printf '%s\n' "$DEPLOY_OUT" | grep -E '^/vol[0-9]+/@appcenter/libretv$' | head -n 1 || true)"
if [ -z "$INSTALL_PATH" ]; then
    INSTALL_PATH="$(printf '%s\n' "$DEPLOY_OUT" | grep -E '^/vol[0-9]+/.*/libretv$' | head -n 1 || true)"
fi
if [ -n "$INSTALL_PATH" ]; then
    info "安装路径: ${INSTALL_PATH}"
    case "$INSTALL_PATH" in
    /vol"${DEPLOY_VOLUME}"/*) info "卷核验通过（/vol${DEPLOY_VOLUME}）" ;;
    *) warn "安装路径不在 /vol${DEPLOY_VOLUME}，请检查卷索引参数" ;;
    esac
else
    warn "未能从输出解析安装路径（见上方 INFO 段）"
fi

# 本机（Mac）侧访问验证
MAC_HEALTH=0
if curl -fsS --max-time 5 "http://${REMOTE_HOST}:8090/api/auth" >/dev/null 2>&1; then
    MAC_HEALTH=1
    info "本机访问 http://${REMOTE_HOST}:8090/api/auth 通过"
else
    warn "本机访问 http://${REMOTE_HOST}:8090/api/auth 失败（可能是防火墙/代理）"
fi

if [ "$HEALTH_FAIL" -ne 0 ] || [ "$MAC_HEALTH" -ne 1 ]; then
    warn "部署完成但健康检查未全部通过，请查看上方日志"
    exit 2
fi

step "部署完成"
info "访问地址: http://${REMOTE_HOST}:8090/"
info "安装检查: appcenter-cli status libretv（NAS 上执行）"
info "应用日志: /vol${DEPLOY_VOLUME}/@appdata/libretv/app.log（即 \$TRIM_PKGVAR/app.log）"
exit 0
