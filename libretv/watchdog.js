#!/usr/bin/env node
'use strict';

/**
 * LibreTV-fnOS 自愈看护进程
 *
 * 由 start.js 以 detached 方式启动，随应用运行载荷一起更新（无需修改 cmd/main）：
 *   - 监视启动它的 start.js 进程；start.js 异常退出（崩溃/被 OOM kill）时自动重新拉起；
 *   - 重新拉起的 start.js 带 LIBRETV_GUARDED=1，不会再启动第二个看护进程；
 *   - start.js 正常停止时写入 watchdog.stop 并终止看护进程，不会“复活”应用；
 *   - 记录重启原因、退出码、信号、运行时长，写入 var/watchdog.log；
 *   - 重启后退避 5s → 10s → 20s → 60s，稳定运行 5 分钟后重置。
 *
 * 用法（由 start.js 调用）：
 *   node watchdog.js --parent <pid> --entry <start.js> --cwd <server> --data <var> --port 8090
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--') && i + 1 < argv.length) {
      out[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const parentPid = Number(args.parent);
const entry = path.resolve(args.entry || path.join(__dirname, 'start.js'));
const cwd = path.resolve(args.cwd || __dirname);
const dataDir = path.resolve(args.data || path.join(cwd, 'var'));
const port = Number(args.port) > 0 ? Number(args.port) : 8090;

const pidFile = path.join(dataDir, 'watchdog.pid');
const appPidFile = path.join(dataDir, 'app.pid');
const stopFile = path.join(dataDir, 'watchdog.stop');
const logFile = path.join(dataDir, 'watchdog.log');

function log(message) {
  const line = `${new Date().toISOString()} [watchdog] ${message}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

function writePidFile(file, pid) {
  try {
    fs.writeFileSync(file, String(pid), 'utf8');
  } catch {
    /* ignore */
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopRequested() {
  return fs.existsSync(stopFile);
}

let stopping = false;
let child = null;
let restartTimer = null;
let healthTimer = null;
let delayMs = 5000;
let lastStartAt = 0;

function cleanupTimers() {
  if (restartTimer) clearTimeout(restartTimer);
  if (healthTimer) clearInterval(healthTimer);
  restartTimer = null;
  healthTimer = null;
}

function exitGuardian(code) {
  stopping = true;
  cleanupTimers();
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on('SIGTERM', () => {
  stopping = true;
  log('收到 SIGTERM，退出看护');
  cleanupTimers();
  if (child && alive(child.pid)) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  exitGuardian(0);
});
process.on('SIGINT', () => {
  try {
    process.kill(process.pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
});

function httpProbe() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/auth', timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startHealthWatch() {
  const deadline = Date.now() + 60000;
  let healthy = false;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (healthy || stopping) {
      clearInterval(healthTimer);
      return;
    }
    const ok = await httpProbe();
    if (ok) {
      healthy = true;
      clearInterval(healthTimer);
      return;
    }
    if (Date.now() >= deadline && child && alive(child.pid)) {
      log('子进程启动后 60 秒未就绪，强制重启');
      clearInterval(healthTimer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (child && alive(child.pid)) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }, 10000).unref();
    }
  }, 3000);
  if (healthTimer && typeof healthTimer.unref === 'function') healthTimer.unref();
}

function spawnChild() {
  if (stopping || stopRequested()) {
    log('检测到停止标记，不再重启');
    exitGuardian(0);
    return;
  }
  try {
    fs.rmSync(stopFile, { force: true });
  } catch {
    /* ignore */
  }
  log(`启动子进程: ${entry}`);
  let childProc;
  let childOut;
  try {
    // 子进程 stdout/stderr 继续写 app.log，保持与首次启动一致的日志位置
    childOut = fs.openSync(path.join(dataDir, 'app.log'), 'a');
    childProc = spawn(process.execPath, [entry], {
      cwd,
      env: { ...process.env, LIBRETV_GUARDED: '1' },
      stdio: ['ignore', childOut, childOut],
    });
  } catch (err) {
    log(`启动子进程失败: ${err && err.message}`);
    scheduleRestart();
    return;
  }
  child = childProc;
  lastStartAt = Date.now();
  writePidFile(appPidFile, child.pid);
  log(`子进程已启动 pid=${child.pid}`);
  startHealthWatch();

  child.on('exit', (code, signal) => {
    const uptimeMs = Date.now() - lastStartAt;
    log(`子进程退出 pid=${child ? child.pid : '?'} code=${code} signal=${signal || ''} 运行 ${(uptimeMs / 1000).toFixed(1)}s`);
    child = null;
    if (stopping || stopRequested()) {
      exitGuardian(0);
      return;
    }
    if (uptimeMs > 5 * 60 * 1000) delayMs = 5000;
    scheduleRestart();
  });
  child.on('error', (err) => {
    log(`子进程错误: ${err && err.message}`);
  });
}

function scheduleRestart() {
  cleanupTimers();
  const wait = delayMs;
  delayMs = Math.min(delayMs * 2, 60000);
  log(`${(wait / 1000).toFixed(0)} 秒后重启（下次间隔 ${(delayMs / 1000).toFixed(0)}s）`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnChild();
  }, wait);
  if (restartTimer && typeof restartTimer.unref === 'function') restartTimer.unref();
}

function watchParent() {
  if (stopping) return;
  if (stopRequested()) {
    log('父进程退出且存在停止标记，退出看护');
    exitGuardian(0);
    return;
  }
  if (!alive(parentPid)) {
    log('父进程已退出，接管并重启应用');
    spawnChild();
    return;
  }
  const timer = setTimeout(watchParent, 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

// 自身 PID 写入 watchdog.pid
writePidFile(pidFile, process.pid);
log(`看护启动 pid=${process.pid} parent=${parentPid} entry=${entry} data=${dataDir}`);
watchParent();
// 保持事件循环
setInterval(() => {}, 60 * 1000);
