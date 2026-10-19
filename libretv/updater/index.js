'use strict';

/**
 * LibreTV-fnOS 应用内自更新（OTA）
 *
 * 工作方式：
 *  - 定时检查 GitHub Releases（默认 HarmonyRun/LibreTV-fnOS）；
 *  - 发现新版本后由 UI 提醒；用户点击更新时：
 *    1) 下载 release 资产 `libretv-update-<ver>.tar.gz`
 *    2) 用 GitHub API 提供的 sha256 digest 校验
 *    3) 解压到 target/server.new-<ver> 并校验关键文件
 *    4) 原子替换 target/server，保留 server.old-<oldver> 备份
 *    5) 通过 cmd/main restart 重启应用（后台脚本，健康检查失败自动回滚）
 *
 * 只替换运行载荷（Next/STRM/MCP/start.js），不修改 App Center 版本号；
 * 配置、索引、STRM 均在 var/，不受影响。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PORT = 8093;
const DEFAULT_REPO = 'HarmonyRun/LibreTV-fnOS';
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_INTERVAL_HOURS = 6;
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function parseVersion(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareVersions(a, b) {
  const pa = parseVersion(a) || { major: 0, minor: 0, patch: 0 };
  const pb = parseVersion(b) || { major: 0, minor: 0, patch: 0 };
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  return 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createUpdater(options = {}) {
  const dataDir = options.dataDir || process.env.LIBRETV_DATA_DIR || path.join(process.cwd(), 'var');
  const serverDir = options.serverDir || path.resolve(__dirname, '..');
  const targetRoot = options.targetRoot || path.dirname(serverDir);
  const appRoot = options.appRoot || path.dirname(targetRoot);
  const cmdMain = options.cmdMain || path.join(appRoot, 'cmd', 'main');
  function resolveCmdMain() {
    // 实际安装布局：server 在 /vol2/@appcenter/<app>/server，
    // cmd 在 /var/apps/<app>/cmd/main（注意 targetRoot 的上一级不是 app 根）。
    const appName = path.basename(appRoot) || path.basename(targetRoot);
    const appDest = process.env.TRIM_APPDEST || '';
    const candidates = [
      cmdMain,
      path.join('/var/apps', appName, 'cmd', 'main'),
      appDest ? path.join('/var/apps', path.basename(appDest), 'cmd', 'main') : '',
      path.join(targetRoot, 'cmd', 'main'),
      path.join(appRoot, 'cmd', 'main'),
    ];
    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
    return '';
  }
  const repo = options.repo || DEFAULT_REPO;
  const apiBase = (options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_PORT;
  const intervalHours = Number(options.intervalHours) > 0 ? Number(options.intervalHours) : DEFAULT_INTERVAL_HOURS;
  const enabled = options.enabled !== false;
  const allowRestart = options.allowRestart !== false;
  const logger = options.logger || console;

  const stateFile = path.join(dataDir, 'update-state.json');
  const updateDir = path.join(dataDir, 'update');
  const logFile = path.join(dataDir, 'update.log');
  const lockFile = path.join(dataDir, 'update.lock');

  const currentVersion =
    (options.version && String(options.version)) || (readJson(path.join(serverDir, 'version.json')) || {}).version || '0.0.0';

  let applying = false;
  let lastStatus = null;

  function log(level, message) {
    const line = `${new Date().toISOString()} [update] ${message}`;
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      /* ignore */
    }
    const fn = logger[level] || logger.log;
    if (typeof fn === 'function') fn(line);
  }

  function readState() {
    return readJson(stateFile) || {};
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
    writeJsonAtomic(stateFile, next);
    return next;
  }

  function status() {
    const state = readState();
    const latestVersion = state.latestVersion || '';
    const updateAvailable = Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0;
    return {
      enabled,
      currentVersion,
      latestVersion,
      updateAvailable,
      notes: state.notes || '',
      htmlUrl: state.htmlUrl || '',
      publishedAt: state.publishedAt || '',
      assetName: state.asset && state.asset.name ? state.asset.name : '',
      lastCheckAt: state.lastCheckAt || '',
      error: state.error || '',
      applying,
      appliedVersion: state.appliedVersion || '',
      lastApplyAt: state.lastApplyAt || '',
      autoCheck: enabled,
      intervalHours,
      repo,
      restartCmd: resolveCmdMain(),
    };
  }

  function pickAsset(assets) {
    if (!Array.isArray(assets)) return null;
    const candidates = assets.filter((a) => a && typeof a.name === 'string' && /^libretv-update-.*\.tar\.gz$/i.test(a.name));
    if (!candidates.length) return null;
    return candidates.find((a) => a.name.includes(`-${statusTagVersion()}-`)) || candidates[0];
  }

  function statusTagVersion() {
    const state = readState();
    return String(state.latestVersion || '').replace(/[^0-9A-Za-z._-]/g, '');
  }

  async function fetchLatest() {
    const url = `${apiBase}/repos/${repo}/releases/latest`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'libretv-fnos-updater',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return res.json();
  }

  async function checkNow(force) {
    if (!enabled) {
      return { ok: false, disabled: true, status: status() };
    }
    const state = readState();
    const last = Date.parse(state.lastCheckAt || '') || 0;
    if (!force && last && Date.now() - last < intervalHours * 3600 * 1000) {
      return { ok: true, cached: true, status: status() };
    }
    try {
      const release = await fetchLatest();
      const tag = String(release.tag_name || release.name || '').trim();
      const version = tag.replace(/^v/i, '');
      if (!parseVersion(version)) throw new Error(`无法解析版本号: ${tag || '(空)'}`);
      const asset = (release.assets || []).find(
        (a) => a && typeof a.name === 'string' && /^libretv-update-.*\.tar\.gz$/i.test(a.name)
      );
      if (!asset) throw new Error('Release 缺少 libretv-update-<ver>.tar.gz 资产');
      if (!asset.digest || !String(asset.digest).startsWith('sha256:')) {
        throw new Error('Release 资产缺少 sha256 digest，无法校验安全');
      }
      const patch = {
        lastCheckAt: new Date().toISOString(),
        error: '',
        latestVersion: version,
        latestTag: tag,
        notes: String(release.body || '').slice(0, 20000),
        htmlUrl: release.html_url || '',
        publishedAt: release.published_at || '',
        asset: {
          name: asset.name,
          url: asset.browser_download_url,
          apiUrl: asset.url || '',
          size: Number(asset.size) || 0,
          digest: String(asset.digest),
        },
      };
      writeState(patch);
      log('info', `检查完成：当前 ${currentVersion}，最新 ${version}`);
      return { ok: true, cached: false, status: status() };
    } catch (err) {
      const message = (err && err.message) || '检查更新失败';
      writeState({ lastCheckAt: new Date().toISOString(), error: message });
      log('warn', `检查更新失败: ${message}`);
      return { ok: false, error: message, status: status() };
    }
  }

  function tarList(file) {
    const res = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', timeout: 120000 });
    if (res.status !== 0) throw new Error(`tar 列表失败: ${(res.stderr || '').slice(0, 300)}`);
    const entries = String(res.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!entries.length) throw new Error('更新包为空');
    for (const entry of entries) {
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`更新包包含非法路径: ${entry}`);
      }
    }
    return entries;
  }

  function extractTar(file, dest) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const res = spawnSync('tar', ['-xzf', file, '-C', dest], { encoding: 'utf8', timeout: 180000 });
    if (res.status !== 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error(`解压失败: ${(res.stderr || '').slice(0, 300)}`);
    }
  }

  function validateStage(stage, version) {
    const must = [
      'start.js',
      'server.js',
      path.join('.next', 'BUILD_ID'),
      path.join('.next', 'server'),
      path.join('node_modules', 'next', 'package.json'),
    ];
    for (const rel of must) {
      if (!fs.existsSync(path.join(stage, rel))) throw new Error(`更新包缺少 ${rel}`);
    }
    const v = readJson(path.join(stage, 'version.json'));
    if (!v || String(v.version) !== String(version)) {
      throw new Error(`更新包版本不匹配（期望 ${version}，实际 ${v ? v.version : '无'}）`);
    }
  }

  function writeRestartScript(version, backupDir, restartCmd) {
    const script = path.join(updateDir, 'restart.sh');
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const content = `#!/bin/bash
set -u
CMD=${q(restartCmd)}
SERVER=${q(serverDir)}
DATA=${q(dataDir)}
LOG="$DATA/update.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [restart] $*" >> "$LOG"; }
sleep 1
log "重启到 ${version}"
"$CMD" stop >>"$LOG" 2>&1
sleep 1
"$CMD" start >>"$LOG" 2>&1
for i in $(seq 1 45); do
    if /usr/bin/curl -sf -m 3 http://127.0.0.1:8090/api/auth >/dev/null 2>&1; then
        log "新版本 ${version} 启动成功"
        exit 0
    fi
    sleep 1
done
log "新版本 ${version} 健康检查失败，回滚"
rm -rf "\${SERVER}.failed"
mv "$SERVER" "\${SERVER}.failed"
mv ${q(backupDir)} "$SERVER"
"$CMD" stop >>"$LOG" 2>&1
sleep 1
"$CMD" start >>"$LOG" 2>&1
`;
    fs.mkdirSync(updateDir, { recursive: true });
    fs.writeFileSync(script, content, { mode: 0o755 });
    return script;
  }

  async function apply() {
    if (!enabled) return { ok: false, error: '自动更新已禁用' };
    if (applying) return { ok: false, error: '已有更新正在进行' };
    applying = true;
    let lockFd = null;
    try {
      lockFd = fs.openSync(lockFile, 'wx');
    } catch {
      applying = false;
      return { ok: false, error: '已有更新任务在运行（lock 存在）' };
    }
    const state = readState();
    try {
      if (!state.latestVersion) {
        const check = await checkNow(true);
        if (!check.ok) return { ok: false, error: check.error || '检查更新失败' };
      }
      const latestState = readState();
      const version = latestState.latestVersion;
      if (compareVersions(version, currentVersion) <= 0) return { ok: false, error: '当前已是最新版本' };
      const asset = latestState.asset;
      if (!asset || !asset.url || !asset.digest) return { ok: false, error: '缺少更新资产信息，请重新检查' };
      log('info', `开始下载 ${asset.name} (${version})`);
      fs.mkdirSync(updateDir, { recursive: true });
      const downloadFile = path.join(updateDir, `download-${version}.tar.gz`);
      fs.rmSync(downloadFile, { force: true });
      // 用系统 curl 下载（GitHub 资产会 302 到 objects.githubusercontent.com，
      // 内置 Node fetch 在部分 NAS 网络下对该域名失败，curl 的 IPv4/重定向更稳）
      const curlBin = fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl';
      // browser_download_url 会走 github.com（国内 NAS 常被阻断）；
      // 优先用 API 资产地址 + Accept: application/octet-stream，GitHub 会 302 到
      // objects.githubusercontent.com（可直连），再用 curl 跟随重定向下载。
      const downloadUrl = asset.apiUrl || asset.url;
      const args = ['-4', '-fL', '-sS', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '300'];
      if (asset.apiUrl) args.push('-H', 'Accept: application/octet-stream');
      args.push('-o', downloadFile, downloadUrl);
      const dl = spawnSync(curlBin, args, { encoding: 'utf8', timeout: 320000 });
      if (dl.status !== 0) {
        throw new Error(`下载失败: ${(dl.stderr || dl.error || '').toString().slice(0, 300)}`);
      }
      const fileBuffer = fs.readFileSync(downloadFile);
      if (fileBuffer.length === 0) throw new Error('下载内容为空');
      if (fileBuffer.length > MAX_DOWNLOAD_BYTES) throw new Error('更新包超过大小限制');
      const digest = sha256(fileBuffer);
      const expected = String(asset.digest).replace(/^sha256:/i, '').toLowerCase();
      if (digest !== expected) throw new Error(`校验失败（期望 ${expected.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`);
      tarList(downloadFile);
      const stage = path.join(targetRoot, `.server.new-${version}`);
      extractTar(downloadFile, stage);
      validateStage(stage, version);
      const backupDir = `${serverDir}.old-${currentVersion}`;
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
        fs.renameSync(serverDir, backupDir);
      } catch (err) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw new Error(`无法备份当前版本: ${(err && err.message) || err}`);
      }
      try {
        fs.renameSync(stage, serverDir);
      } catch (err) {
        try {
          fs.renameSync(backupDir, serverDir);
        } catch {
          /* ignore */
        }
        throw new Error(`替换失败，已尝试恢复: ${(err && err.message) || err}`);
      }
      writeState({
        appliedVersion: version,
        lastApplyAt: new Date().toISOString(),
        pendingRestart: true,
        error: '',
      });
      log('info', `已替换运行载荷到 ${version}，准备重启`);
      const restartCmd = resolveCmdMain();
      log('info', `重启检查: cmd=${restartCmd || 'NOT_FOUND'} allowRestart=${allowRestart}`);
      const canRestart = allowRestart && Boolean(restartCmd);
      if (!canRestart) {
        return {
          ok: true,
          from: currentVersion,
          to: version,
          restarting: false,
          restartSkipped: true,
          restartReason: restartCmd ? 'allowRestart=false' : '未找到 cmd/main',
          cmdMain,
          restartCmd,
        };
      }
      const script = writeRestartScript(version, backupDir, restartCmd);
      const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore', cwd: dataDir });
      child.unref();
      return { ok: true, from: currentVersion, to: version, restarting: true };
    } catch (err) {
      const message = (err && err.message) || '更新失败';
      writeState({ error: message });
      log('error', `更新失败: ${message}`);
      return { ok: false, error: message };
    } finally {
      applying = false;
      try {
        if (lockFd !== null) fs.closeSync(lockFd);
        fs.rmSync(lockFile, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (statusCode, body) => {
      const text = JSON.stringify(body);
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/status') return send(200, status());
      if (req.method === 'POST' && url.pathname === '/check') return send(200, await checkNow(true));
      if (req.method === 'POST' && url.pathname === '/apply') return send(200, await apply());
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, currentVersion });
      return send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: (err && err.message) || 'internal error' });
    }
  });

  let timer = null;
  return {
    start() {
      if (!enabled) {
        log('info', '自动更新已禁用');
        return { started: false };
      }
      server.listen(port, '127.0.0.1', () => log('info', `更新服务已启动: http://127.0.0.1:${port}（当前 ${currentVersion}）`));
      setTimeout(() => checkNow(false).catch(() => undefined), 15000).unref();
      timer = setInterval(() => checkNow(false).catch(() => undefined), intervalHours * 3600 * 1000);
      timer.unref();
      return { started: true };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
    checkNow,
    apply,
    status,
    currentVersion,
    _internal: { compareVersions, parseVersion, checkNow, apply, readState, writeState },
  };
}

module.exports = { createUpdater, DEFAULT_PORT, DEFAULT_REPO };
