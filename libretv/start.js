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

// ---- 优雅退出 ----------------------------------------------------------------
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', `收到 ${signal}，正在退出`);
  try {
    if (engineHandle && typeof engineHandle.stop === 'function') engineHandle.stop();
    if (mediaProxyHandle && typeof mediaProxyHandle.stop === 'function') mediaProxyHandle.stop();
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
});
process.on('unhandledRejection', (err) => {
  log('error', `unhandledRejection: ${err && err.stack ? err.stack : err}`);
});

// ---- 启动 Next ---------------------------------------------------------------
log('info', `启动 LibreTV Web: 0.0.0.0:${port} (cwd=${process.cwd()})`);
require('./server.js');
