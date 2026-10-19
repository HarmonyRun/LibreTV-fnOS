#!/bin/bash
# 飞牛 SSH 串行化包装器（团队共用）— 原生 SSH 实现
#
# 背景：
#   1) feiniu-ssh 技能脚本每次调用新建连接，短时间多连接容易被 sshd 限流；
#   2) 技能脚本用输出里是否含 "Permission denied" 判断认证失败，误伤那些
#      命令自身输出 Permission denied 的情况（如 cat 安装日志、appcenter-cli 非 root 执行），
#      导致命令明明执行成功却被当作认证失败。
#   本脚本直接调用 ssh/sshpass，保留正确退出码，并只把 sshpass 的真实认证失败当认证失败。
#
# 用法（完全兼容 feiniu-ssh）：
#   scripts/ssh.sh '远程命令'
#   scripts/ssh.sh -r 'root 命令'           # sudo -n 提权
#   scripts/ssh.sh -T '需要 TTY 的命令'
#   scripts/ssh.sh --ping                   # 连通性 + 认证检查
#   scripts/ssh.sh --print-cmd 'cmd'        # 打印真实 ssh 命令（密码打码）
#   scripts/ssh.sh --info                   # 主机概览
#
# 环境变量：FEINIU_HOST/PORT/USER/PASS（优先）、FEINIU_CONF（默认技能 feiniu.conf）
#   FEINIU_SSH_RETRIES（默认 4）、FEINIU_SSH_BACKOFF（默认 25 秒）、
#   FEINIU_SSH_LOCK_TIMEOUT（默认 600 秒）、FEINIU_SSH_LOCK_DIR
set -u

SKILL_DIR="$HOME/.dsh/skills/飞牛SSH连接"
SSH_CONF="${FEINIU_CONF:-$SKILL_DIR/feiniu.conf}"
KNOWN_HOSTS_FILE="${FEINIU_KNOWN_HOSTS:-$SKILL_DIR/.known_hosts}"
LOCK_DIR="${FEINIU_SSH_LOCK_DIR:-/tmp/feiniu-ssh.lock.d}"
LOCK_TIMEOUT="${FEINIU_SSH_LOCK_TIMEOUT:-600}"
RETRIES="${FEINIU_SSH_RETRIES:-4}"
BACKOFF="${FEINIU_SSH_BACKOFF:-25}"

FEINIU_HOST="${FEINIU_HOST:-}"; FEINIU_PORT="${FEINIU_PORT:-}"; FEINIU_USER="${FEINIU_USER:-}"; FEINIU_PASS="${FEINIU_PASS:-}"
if [ -f "$SSH_CONF" ]; then
  # shellcheck disable=SC1090
  . "$SSH_CONF"
fi
HOST="${FEINIU_HOST:-192.168.1.100}"
PORT="${FEINIU_PORT:-23}"
USER="${FEINIU_USER:-test}"
PASS="${FEINIU_PASS:-}"

die() { echo "[ssh.sh] $*" >&2; exit "${2:-2}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖命令: $1" 3; }
need sshpass
need ssh

REMOTE_CMD=""
MODE="normal"
while [ $# -gt 0 ]; do
  case "$1" in
    -r) MODE="root"; shift ;;
    -T) MODE="tty"; shift ;;
    --ping) MODE="ping"; shift ;;
    --print-cmd) MODE="print"; shift ;;
    --info) MODE="info"; shift ;;
    -i) die "交互式 shell 请直接使用技能脚本" 2 ;;
    *) REMOTE_CMD="$1"; shift ;;
  esac
done

if [ "$MODE" = "info" ] && [ -z "$REMOTE_CMD" ]; then
  REMOTE_CMD='hostname; echo "---"; cat /etc/os-release 2>/dev/null | head -3; echo "---"; uptime; echo "---"; df -h /vol1 /vol2 /vol3 2>/dev/null'
fi
if [ "$MODE" = "ping" ]; then
  REMOTE_CMD='echo PING_OK; hostname; whoami'
fi
[ -n "$REMOTE_CMD" ] || die "用法: $0 [-r|-T|--ping|--print-cmd|--info] '<远程命令>'" 2
[ -n "$PASS" ] || die "缺少 FEINIU_PASS（检查 $SSH_CONF 或环境变量）" 3

# 远程命令按传入原样执行（ssh 会交给远端 shell）；-r 用 sudo -n 包一层
if [ "$MODE" = "root" ]; then
  REMOTE_CMD="sudo -n bash -c $(printf '%q' "$REMOTE_CMD")"
fi

SSH_OPTS=(
  -F /dev/null
  -p "$PORT"
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
  -o LogLevel=ERROR
  -o ConnectTimeout=10
)
[ "$MODE" = "tty" ] && SSH_OPTS+=(-tt)

if [ "$MODE" = "print" ]; then
  echo "sshpass -p '***' ssh ${SSH_OPTS[*]} ${USER}@${HOST} $(printf '%q' "$REMOTE_CMD")"
  exit 0
fi

# ---- 本机串行锁（mkdir 原子操作，兼容 macOS） --------------------------------
acquired=0; waited=0
while [ "$acquired" -eq 0 ]; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    acquired=1
    printf '%s\n' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
  else
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "${holder:-}" ] && ! kill -0 "$holder" 2>/dev/null; then
      echo "[ssh.sh] 清理陈旧锁（pid $holder 已不存在）" >&2
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      echo "[ssh.sh] 等待 SSH 锁超时（${LOCK_TIMEOUT}s），强制接管" >&2
      rm -rf "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
done
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# ---- 执行（真实认证失败才退避重试） -----------------------------------------
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY 2>/dev/null || true
attempt=1
while :; do
  OUT="$(sshpass -p "$PASS" ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "$REMOTE_CMD" 2>&1)"
  rc=$?
  # 过滤 test 用户 home 缺失导致的无害警告
  OUT="$(printf '%s\n' "$OUT" | grep -v 'Could not chdir to home directory' || true)"
  [ -n "$OUT" ] && printf '%s\n' "$OUT"

  if [ "$rc" -eq 255 ]; then
    # ssh 自身错误：认证失败 / 连接失败 / 主机 key 等才重试
    if printf '%s' "$OUT" | grep -qiE 'Permission denied, please try again|Permission denied \(password|Host key verification failed|Connection (refused|timed out)|Connection closed by'; then
      if [ "$attempt" -ge "$RETRIES" ]; then
        echo "[ssh.sh] SSH 连接失败（rc=255），已重试 $((attempt-1)) 次，放弃" >&2
        exit 5
      fi
      echo "[ssh.sh] SSH 连接失败（rc=255），${BACKOFF}s 后重试（${attempt}/$((RETRIES-1))）..." >&2
      sleep "$BACKOFF"; attempt=$((attempt + 1)); continue
    fi
  fi
  exit "$rc"
done
