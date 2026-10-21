#!/usr/bin/env node
/**
 * LibreTV fnOS 应用进程入口。
 *
 * 单进程模型：
 *   1) 启动内置 STRM 引擎（后台队列 + 定时同步）
 *   2) require Next.js standalone server.js 提供 Web 服务
 *
 * 由 cmd/main 通过内置 node 运行时启动：
 *   cd "$TRIM_APPDEST/server" && "$TRIM_APPDEST/node/bin/node" start.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---- 数据目录 ----------------------------------------------------------------
const dataDir =
  process.env.LIBRETV_DATA_DIR ||
  process.env.TRIM_PKGVAR ||
  path.join(__dirname, 'var');

process.env.LIBRETV_DATA_DIR = dataDir;
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });
} catch (err) {
  console.error(`[start] 无法创建数据目录 ${dataDir}: ${err && err.message}`);
}

// ---- Next standalone 运行参数 ------------------------------------------------
const port = String(
  process.env.TRIM_SERVICE_PORT || process.env.LIBRETV_PORT || process.env.PORT || '8090'
);
process.env.PORT = port;
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
process.env.NODE_ENV = 'production';
process.env.NEXT_TELEMETRY_DISABLED = '1';

// ---- 日志：stdout/stderr 由 cmd/main 重定向到 var/app.log --------------------
function log(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}${
    extra === undefined ? '' : ' ' + safeJson(extra)
  }`;
  if (level === 'error') console.error(line);
  else console.log(line);
}
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---- 自愈看护（watchdog） ----------------------------------------------------
const WATCHDOG_SCRIPT = path.join(__dirname, 'watchdog.js');
const WATCHDOG_PID_FILE = path.join(dataDir, 'watchdog.pid');
const WATCHDOG_STOP_FILE = path.join(dataDir, 'watchdog.stop');
let watchdogPid = null;

function readPidFile(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function isWatchdogProcess(pid) {
  if (!pid) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('watchdog.js');
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

function stopWatchdog() {
  try {
    fs.writeFileSync(WATCHDOG_STOP_FILE, String(Date.now()), 'utf8');
  } catch {
    /* ignore */
  }
  const pid = watchdogPid || readPidFile(WATCHDOG_PID_FILE);
  if (pid && pid !== process.pid && isWatchdogProcess(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(WATCHDOG_PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

function startWatchdog() {
  if (process.env.LIBRETV_GUARDED === '1') {
    log('info', '运行在看护模式（LIBRETV_GUARDED=1），不再启动额外看护进程');
    return;
  }
  if (!fs.existsSync(WATCHDOG_SCRIPT)) {
    log('warn', `未找到 ${WATCHDOG_SCRIPT}，自愈功能不可用`);
    return;
  }
  // 清理上次异常停留下仍存活的老看护进程
  const stale = readPidFile(WATCHDOG_PID_FILE);
  if (stale && stale !== process.pid && isWatchdogProcess(stale)) {
    try {
      process.kill(stale, 'SIGTERM');
      log('warn', `已清理遗留看护进程 pid=${stale}`);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(WATCHDOG_STOP_FILE, { force: true });
  } catch {
    /* ignore */
  }
  try {
    const out = fs.openSync(path.join(dataDir, 'watchdog.log'), 'a');
    const child = spawn(
      process.execPath,
      [WATCHDOG_SCRIPT, '--parent', String(process.pid), '--entry', __filename, '--cwd', __dirname, '--data', dataDir, '--port', port],
      {
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, LIBRETV_WATCHDOG: '1' },
      }
    );
    child.unref();
    watchdogPid = child.pid;
    fs.writeFileSync(WATCHDOG_PID_FILE, String(child.pid), 'utf8');
    log('info', `已启动自愈看护进程 pid=${child.pid}（异常退出将自动重启）`);
  } catch (err) {
    log('warn', `自愈看护启动失败（不影响主进程）: ${err && err.message}`);
  }
}

startWatchdog();

// ---- 启动 STRM 引擎（失败不阻塞 Web） ---------------------------------------
let engineHandle = null;
try {
  // engine/index.js 由 engine-dev 提供；require 失败时 Web 仍可用
  const { startEngine } = require(path.join(__dirname, 'engine', 'index.js'));
  if (typeof startEngine !== 'function') {
    throw new Error('engine/index.js 未导出 startEngine');
  }
  engineHandle = startEngine({
    dataDir,
    logger: { log, info: (m, e) => log('info', m, e), warn: (m, e) => log('warn', m, e), error: (m, e) => log('error', m, e) },
  });
  log('info', `STRM 引擎已启动，数据目录 ${dataDir}`);
} catch (err) {
  log('error', `STRM 引擎启动失败（Web 继续运行）: ${err && err.stack ? err.stack : err}`);
}

// ---- 启动影视兼容代理（方案 C：反向代理 + HLS 中转 + 播放响应改写） ----------
let mediaProxyHandle = null;
try {
  const cfg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const mediaProxyCfg = cfg && cfg.mediaProxy && typeof cfg.mediaProxy === 'object' ? cfg.mediaProxy : {};
  const enabled = mediaProxyCfg.enabled !== false;
  const proxyPort = Number(mediaProxyCfg.port) > 0 ? Number(mediaProxyCfg.port) : 8091;
  if (enabled) {
    const { createMediaProxy } = require(path.join(__dirname, 'mediaserver', 'index.js'));
    mediaProxyHandle = createMediaProxy({ dataDir, logger: { log, info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) }, port: proxyPort });
    mediaProxyHandle.start().catch((err) => log('error', `影视代理启动失败: ${err && err.message}`));
  } else {
    log('info', '影视代理已禁用（config.mediaProxy.enabled=false）');
  }
} catch (err) {
  log('error', `影视代理启动失败（主 Web 继续运行）: ${err && err.stack ? err.stack : err}`);
}

// ---- 启动 MCP 服务（大模型通过 MCP 管理媒体库） ------------------------------
let mcpHandle = null;
try {
  const cfg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const mcpCfg = cfg && cfg.mcp && typeof cfg.mcp === 'object' ? cfg.mcp : {};
  const enabled = mcpCfg.enabled !== false;
  const mcpPort = Number(mcpCfg.port) > 0 ? Number(mcpCfg.port) : 8092;
  if (enabled) {
    const { createMcpServer } = require(path.join(__dirname, 'mcp', 'index.js'));
    mcpHandle = createMcpServer({
      dataDir,
      logger: { log, info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      port: mcpPort,
    });
    mcpHandle.start().catch((err) => log('error', `MCP 启动失败: ${err && err.message}`));
  } else {
    log('info', 'MCP 服务已禁用（config.mcp.enabled=false）');
  }
} catch (err) {
  log('error', `MCP 启动失败（主 Web 继续运行）: ${err && err.stack ? err.stack : err}`);
}

// ---- 启动应用内自更新（OTA） -------------------------------------------------
let updaterHandle = null;
try {
  const cfg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const updCfg = cfg && cfg.update && typeof cfg.update === 'object' ? cfg.update : {};
  if (updCfg.enabled !== false) {
    const { createUpdater } = require(path.join(__dirname, 'updater', 'index.js'));
    updaterHandle = createUpdater({
      dataDir,
      logger: { log, info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      repo: updCfg.repo,
      port: updCfg.port,
      intervalHours: updCfg.intervalHours,
      enabled: true,
    });
    updaterHandle.start();
  } else {
    log('info', '自动更新已禁用（config.update.enabled=false）');
  }
} catch (err) {
  log('error', `更新服务启动失败（不影响主服务）: ${err && err.stack ? err.stack : err}`);
}

// ---- 优雅退出 ----------------------------------------------------------------
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', `收到 ${signal}，正在退出`);
  stopWatchdog();
  try {
    if (engineHandle && typeof engineHandle.stop === 'function') engineHandle.stop();
    if (mediaProxyHandle && typeof mediaProxyHandle.stop === 'function') mediaProxyHandle.stop();
    if (mcpHandle && typeof mcpHandle.stop === 'function') mcpHandle.stop();
    if (updaterHandle && typeof updaterHandle.stop === 'function') updaterHandle.stop();
  } catch (err) {
    log('error', `停止引擎失败: ${err && err.message}`);
  }
  // Next standalone 无显式 close API；直接退出，交给 system/app center 处理
  setTimeout(() => process.exit(0), 50).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', `uncaughtException: ${err && err.stack ? err.stack : err}`);
  // 交给看护进程重启；若没有看护进程则保持旧行为之外的快速失败（新版 FPK 均带 watchdog.js）
  setTimeout(() => process.exit(1), 100).unref();
});
process.on('unhandledRejection', (err) => {
  log('error', `unhandledRejection: ${err && err.stack ? err.stack : err}`);
});

// ---- 启动 Next ---------------------------------------------------------------
log('info', `启动 LibreTV Web: 0.0.0.0:${port} (cwd=${process.cwd()})`);
require('./server.js');
