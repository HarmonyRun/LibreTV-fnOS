'use strict';

/**
 * 飞牛影视兼容代理（方案 C）。
 *
 * 作用：
 *   1) 反向代理 127.0.0.1:8005 的飞牛影视 Web/API，浏览器只访问本应用（局域网），
 *      不依赖客户端（Mac）代理，也不要求影视端支持 HLS STRM；
 *   2) 拦截 POST /v/api/v1/play/play：影视端对 HLS STRM 会返回 DirectLinkPullError
 *      （0.9.8 限制），代理根据 item 元信息匹配本地 strm-index.json，改写为
 *      code=0 + play_link=/__strm/<签名 token>；
 *   3) /__strm/* 中转 HLS：拉取源站 m3u8 并把子播放列表/分片重写回本代理，
 *      由 NAS 统一取流（带 UA/Referer），客户端只与本应用通信。
 *
 * 设计约束：单进程、零 npm 依赖、失败降级不影响主 Web。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_PORT = 8091;
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8005;
const TOKEN_SALT = 'libretv-media-proxy-v1';
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_M3U8 = 8 * 1024 * 1024;
const CACHE_MS = 3000;
const SESSION_COOKIE = 'ltv_session';

/**
 * 复用 LibreTV 的 ltv_session 签名会话（cookie 不区分端口，8090 登录后 8091 可直接校验），
 * 满足应用商店“监听端口必须有自己的鉴权机制，不可免鉴权访问”的要求。
 * 关闭方式：config.json -> mediaProxy.requireAuth = false（仅调试用）。
 */
function sessionSecret() {
  if (process.env.PROXY_SECRET) return process.env.PROXY_SECRET;
  const pwd = process.env.PASSWORD || '';
  return crypto.createHash('sha256').update(`${pwd}:libretv::session-salt`).digest('hex');
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = parseInt(payload, 10);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function hasLibreTvSession(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE]);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 飞牛影视前端全局常量（0.9.8-1 实测）；版本变化时可由环境变量覆盖
const MEDIA_SECRET = process.env.LIBRETV_MEDIA_SECRET || 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const MEDIA_APIKEY = process.env.LIBRETV_MEDIA_APIKEY || '16CCEB3D-AB42-077D-36A1-F355324E4237';

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

/** 标题归一化：用于把影视刮削标题匹配回 CMS 条目 */
function normalizeTitle(input) {
  let s = String(input || '').toLowerCase();
  s = s.replace(/[\s\u3000]+/g, '');
  s = s.replace(/第[一二三四五六七八九十百零\d]+季/g, '');
  s = s.replace(/season\s*\d+/g, '');
  s = s.replace(/s\d{1,2}(?=e\d|$)/g, '');
  s = s.replace(/[：:·・,，.。!！?？'"“”‘’()（）\[\]【】\-_—–/\\|]/g, '');
  return s;
}

function titleMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.startsWith(nb) || nb.startsWith(na)) {
    return 70 - Math.abs(na.length - nb.length);
  }
  return 0;
}

function originOf(u) {
  try {
    const x = new URL(u);
    return x.origin + '/';
  } catch {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 影视 API 内部签名调用（用于 play/info 取元信息）
// ---------------------------------------------------------------------------

function makeAuthx(apiPath, bodyObj) {
  const nonce = String(Math.floor(100000 + Math.random() * 900000));
  const ts = String(Date.now());
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const bodyHash = md5(body);
  const sign = md5([MEDIA_SECRET, apiPath, nonce, ts, bodyHash, MEDIA_APIKEY].join('_'));
  return { header: `nonce=${nonce}&timestamp=${ts}&sign=${sign}`, body };
}

function mediaApi(apiPath, bodyObj, authorization) {
  return new Promise((resolve) => {
    let body = '';
    let authx = '';
    try {
      const x = makeAuthx(apiPath, bodyObj);
      body = x.body;
      authx = x.header;
    } catch {
      resolve(null);
      return;
    }
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      authx,
    };
    if (authorization) headers.Authorization = authorization;
    const req = http.request(
      { host: BACKEND_HOST, port: BACKEND_PORT, path: apiPath, method: 'POST', headers, timeout: 15000 },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_JSON_BODY) chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// 代理实现
// ---------------------------------------------------------------------------

function createMediaProxy({ dataDir, logger, port = DEFAULT_PORT } = {}) {
  const log = {
    info: (m) => (logger && logger.info ? logger.info(`[media-proxy] ${m}`) : console.log(`[media-proxy] ${m}`)),
    warn: (m) => (logger && logger.warn ? logger.warn(`[media-proxy] ${m}`) : console.warn(`[media-proxy] ${m}`)),
    error: (m) => (logger && logger.error ? logger.error(`[media-proxy] ${m}`) : console.error(`[media-proxy] ${m}`)),
  };

  // 缓存 config.json / strm-index.json，避免每次请求读盘
  let configCache = { at: 0, value: null };
  let indexCache = { at: 0, value: null };
  function getConfig() {
    const now = Date.now();
    if (now - configCache.at < CACHE_MS) return configCache.value;
    const cfg = readJson(path.join(dataDir, 'config.json')) || {};
    configCache = { at: now, value: cfg };
    return cfg;
  }
  function getIndexEntries() {
    const now = Date.now();
    if (now - indexCache.at < CACHE_MS) return indexCache.value;
    const raw = readJson(path.join(dataDir, 'strm-index.json')) || {};
    const entries = [];
    const map = raw && typeof raw.entries === 'object' && raw.entries ? raw.entries : {};
    for (const [key, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object') continue;
      entries.push({ key, ...entry });
    }
    indexCache = { at: now, value: entries };
    return entries;
  }

  function authRequired() {
    const cfg = getConfig();
    const mp = cfg.mediaProxy && typeof cfg.mediaProxy === 'object' ? cfg.mediaProxy : {};
    return mp.requireAuth !== false;
  }

  function rejectUnauthorized(req, res, pathname) {
    // 健康检查保持公开；浏览器导航跳转到 LibreTV 登录页，API/HLS 请求返回 401
    if (pathname === '/__strm/health' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return true;
    }
    if (!hasLibreTvSession(req)) {
      const accept = String(req.headers.accept || '');
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (req.method === 'GET' && accept.includes('text/html')) {
        res.writeHead(302, { Location: `http://${host}:8090/` });
        res.end();
      } else {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('401 Unauthorized: 请先在 LibreTV(8090) 登录');
      }
      return true;
    }
    return false;
  }

  function getSecret() {
    const cfg = getConfig();
    const pwd = String(cfg.password || 'libretv');
    return crypto.createHash('sha256').update(`${TOKEN_SALT}:${pwd}`).digest();
  }

  function signToken(payload) {
    const data = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('hex').slice(0, 24);
    return `${data}.${sig}`;
  }
  function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const data = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = crypto.createHmac('sha256', getSecret()).update(data).digest('hex').slice(0, 24);
    if (sig.length !== expect.length) return null;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
      const payload = JSON.parse(b64urlDecode(data));
      if (!payload || typeof payload.u !== 'string' || !/^https?:\/\//i.test(payload.u)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** 把影视条目元信息匹配到本地 CMS 索引，返回播放 URL */
  function resolveSourceUrl(infoItem) {
    if (!infoItem || typeof infoItem !== 'object') return null;
    const entries = getIndexEntries();
    if (!entries.length) return null;
    const type = String(infoItem.type || '');
    let candidates = [];
    if (type === 'Episode') {
      const seriesTitle = infoItem.tv_title || infoItem.parent_title || '';
      const seriesGuid = infoItem.tv_title ? '' : '';
      candidates = entries
        .filter((e) => String(e.type) === 'tv')
        .map((e) => ({ entry: e, score: titleMatch(e.title, seriesTitle) + (e.year && String(infoItem.air_date || '').startsWith(String(e.year)) ? 1 : 0) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (!candidates.length) return null;
      const entry = candidates[0].entry;
      const list = Array.isArray(entry.lastKnownUrls) ? entry.lastKnownUrls : [];
      if (!list.length) return null;
      const ep = Number(infoItem.episode_number || 1);
      const season = Number(infoItem.season_number || 1);
      let idx = Math.max(0, ep - 1);
      if (season > 1) {
        // 多季：优先按 strm 文件名 SxxExx 匹配
        const paths = Array.isArray(entry.strmPaths) ? entry.strmPaths : [];
        const tag = `S${String(season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`;
        const hit = paths.findIndex((p) => String(p).includes(tag));
        if (hit >= 0) idx = hit;
      }
      return {
        url: list[Math.min(idx, list.length - 1)],
        entry,
        matchedBy: `tv:${seriesTitle}:S${season}E${ep}`,
        _seriesGuid: seriesGuid,
      };
    }
    // Movie / Video
    const title = infoItem.title || infoItem.original_title || '';
    candidates = entries
      .filter((e) => String(e.type) !== 'tv')
      .map((e) => {
        let score = titleMatch(e.title, title);
        if (score && e.year && infoItem.release_date && String(infoItem.release_date).startsWith(String(e.year))) score += 5;
        return { entry: e, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) return null;
    const entry = candidates[0].entry;
    const list = Array.isArray(entry.lastKnownUrls) ? entry.lastKnownUrls : [];
    if (!list.length) return null;
    return { url: list[0], entry, matchedBy: `movie:${title}` };
  }

  function buildSyntheticPlayResponse(mediaGuid, videoGuid, sourceUrl) {
    const token = signToken({ u: sourceUrl, r: originOf(sourceUrl) });
    return {
      msg: '',
      code: 0,
      data: {
        audio_guid: '',
        audio_index: -1,
        hls_time: 4,
        is_subtitle_external: 1,
        media_guid: mediaGuid,
        play_link: `/__strm/${token}`,
        subtitle_guid: '',
        subtitle_index: -1,
        subtitle_link: '',
        video_guid: videoGuid || '',
        video_index: 0,
        non_fatal_errno: null,
        video_encoder: '',
        not_supported_resolution: '',
        supported_highest_resolution: '',
      },
    };
  }

  // ---- /__strm relay ------------------------------------------------------

  function fetchUpstream(url, extraHeaders, redirects = 5) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        reject(e);
        return;
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      const headers = { 'User-Agent': UA, Accept: '*/*', ...extraHeaders };
      const req = mod.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
          timeout: 25000,
          rejectUnauthorized: false,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            const next = new URL(res.headers.location, url).href;
            res.resume();
            fetchUpstream(next, extraHeaders, redirects - 1).then(resolve, reject);
            return;
          }
          resolve({ res, finalUrl: url });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('upstream timeout'));
      });
      req.end();
    });
  }

  function rewritePlaylist(text, baseUrl, referer) {
    const lines = text.split(/\r?\n/);
    const out = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (m, uri) => {
          let abs;
          try {
            abs = new URL(uri, baseUrl).href;
          } catch {
            return m;
          }
          const t = signToken({ u: abs, r: referer });
          return `URI="/__strm/${t}"`;
        });
      }
      let abs;
      try {
        abs = new URL(trimmed, baseUrl).href;
      } catch {
        return line;
      }
      return `/__strm/${signToken({ u: abs, r: referer })}`;
    });
    return out.join('\n');
  }

  function handleRelay(req, res, pathname) {
    const token = decodeURIComponent(pathname.slice('/__strm/'.length));
    const payload = verifyToken(token);
    if (!payload) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('invalid relay token');
      return;
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (payload.r) headers.Referer = payload.r;
    fetchUpstream(payload.u, headers)
      .then(({ res: up, finalUrl }) => {
        const ctype = String(up.headers['content-type'] || '');
        const isM3u8 = /mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(payload.u) || /\.m3u8(\?|$)/i.test(up.req.path);
        if (isM3u8) {
          const chunks = [];
          let size = 0;
          up.on('data', (c) => {
            size += c.length;
            if (size <= MAX_M3U8) chunks.push(c);
          });
          up.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const rewritten = rewritePlaylist(text, finalUrl, payload.r || originOf(payload.u));
            const buf = Buffer.from(rewritten, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Content-Length': buf.length,
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(buf);
          });
          up.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          });
          return;
        }
        const outHeaders = {
          'Content-Type': ctype || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
        };
        for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) {
          if (up.headers[k]) outHeaders[k.replace(/(^|-)\w/g, (m) => m.toUpperCase())] = up.headers[k];
        }
        res.writeHead(up.statusCode || 200, outHeaders);
        up.pipe(res);
        up.on('error', () => res.destroy());
      })
      .catch((err) => {
        log.warn(`relay 失败: ${payload.u.slice(0, 120)} (${err && err.message})`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('upstream fetch failed');
      });
  }

  /** 从 /stream 的 file_stream.path 读取 .strm 源 URL（限制在 strmRoot 内） */
  function sourceUrlFromStrmPath(filePath) {
    try {
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.strm')) return null;
      const cfg = getConfig();
      const root = String(cfg.strmRoot || '').trim();
      const resolved = path.resolve(filePath);
      if (root) {
        const rootResolved = path.resolve(root);
        if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
      }
      const text = fs.readFileSync(resolved, 'utf8');
      const url = text.split(/\r?\n/).map((x) => x.trim()).find((x) => /^https?:\/\//i.test(x));
      return url || null;
    } catch {
      return null;
    }
  }

  /** 通过影视 /stream 接口取 file_stream.path → 源 URL */
  async function resolveSourceByMedia(mediaGuid, authorization) {
    const data = await mediaApi(
      '/v/api/v1/stream',
      { media_guid: mediaGuid, ip: '127.0.0.1', header: { 'User-Agent': [UA] } },
      authorization
    );
    if (!data || data.code !== 0 || !data.data) return null;
    const filePath = data.data.file_stream && data.data.file_stream.path;
    const fromFile = sourceUrlFromStrmPath(filePath);
    if (fromFile) return { url: fromFile, via: 'file_stream.path' };
    const qs = Array.isArray(data.data.direct_link_qualities) ? data.data.direct_link_qualities : [];
    for (const q of qs) if (q && typeof q.url === 'string' && /^https?:\/\//i.test(q.url)) return { url: q.url, via: 'direct_link_qualities' };
    return null;
  }

  /** 把 /stream 响应里的直链 URL 全部改写为本应用中转地址 */
  function rewriteStreamResponse(json, authorization) {
    return (async () => {
      if (!json || json.code !== 0 || !json.data || typeof json.data !== 'object') return json;
      const data = json.data;
      const lists = [];
      if (Array.isArray(data.direct_link_qualities)) lists.push(data.direct_link_qualities);
      if (Array.isArray(data.qualities)) lists.push(data.qualities);
      let rewritten = 0;
      for (const list of lists) {
        for (const q of list) {
          if (!q || typeof q !== 'object') continue;
          const u = typeof q.url === 'string' ? q.url : '';
          if (!/^https?:\/\//i.test(u)) continue;
          q.url = `/__strm/${signToken({ u, r: originOf(u) })}`;
          q.is_m3u8 = true;
          rewritten += 1;
        }
      }
      // 没有直链列表时，用 file_stream.path 兜底补一条
      if (!rewritten && data.file_stream && data.file_stream.path) {
        const src = sourceUrlFromStrmPath(data.file_stream.path);
        if (src) {
          data.direct_link_qualities = [{ bitrate: 0, resolution: '原画', progressive: false, is_m3u8: true, url: `/__strm/${signToken({ u: src, r: originOf(src) })}` }];
          rewritten = 1;
        }
      }
      if (rewritten) log.info(`/stream 直链已改写为中转（${rewritten} 条）`);
      return json;
    })();
  }

  function forwardJson(rawUrl, bodyText, headers) {
    return new Promise((resolve) => {
      const chunks = [];
      const upReq = http.request(
        { host: BACKEND_HOST, port: BACKEND_PORT, method: 'POST', path: rawUrl, headers, timeout: 40000 },
        (upRes) => {
          let size = 0;
          upRes.on('data', (c) => {
            size += c.length;
            if (size <= MAX_JSON_BODY) chunks.push(c);
          });
          upRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          upRes.on('error', () => resolve(''));
        }
      );
      upReq.on('error', () => resolve(''));
      upReq.on('timeout', () => upReq.destroy());
      upReq.end(bodyText);
    });
  }

  function jsonReply(res, obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
    res.end(buf);
  }

  function handleStream(req, res, rawUrl) {
    readBody(req, 1024 * 1024).then(async (bodyText) => {
      const headers = { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` };
      delete headers['accept-encoding'];
      headers['content-length'] = Buffer.byteLength(bodyText);
      const upstreamText = await forwardJson(rawUrl, bodyText, headers);
      let json = null;
      try {
        json = JSON.parse(upstreamText);
      } catch {
        json = null;
      }
      if (!json) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(upstreamText || '{}');
        return;
      }
      const rewritten = await rewriteStreamResponse(json, req.headers.authorization);
      jsonReply(res, rewritten);
    });
  }

  // ---- 普通反向代理 -------------------------------------------------------

  function proxyNormal(req, res, rawUrl) {
    const headers = { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` };
    delete headers['accept-encoding'];
    const upReq = http.request(
      { host: BACKEND_HOST, port: BACKEND_PORT, method: req.method, path: rawUrl, headers, timeout: 30000 },
      (upRes) => {
        const outHeaders = { ...upRes.headers };
        // 后端可能返回绝对 Location，统一改成相对，避免把浏览器带回 5667/8005
        if (outHeaders.location && /^http/i.test(String(outHeaders.location))) {
          try {
            const loc = new URL(String(outHeaders.location));
            outHeaders.location = loc.pathname + loc.search;
          } catch {
            /* ignore */
          }
        }
        res.writeHead(upRes.statusCode || 502, outHeaders);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      }
    );
    upReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('media backend unavailable');
    });
    upReq.on('timeout', () => upReq.destroy());
    req.pipe(upReq);
  }

  function readBody(req, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= limit) chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  /** 拦截 play/play：影视端 DirectLinkPullError 时改写到本地中转 */
  function handlePlayPlay(req, res, rawUrl) {
    readBody(req, 1024 * 1024).then(async (bodyText) => {
      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }
      const headers = { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` };
      delete headers['accept-encoding'];
      headers['content-length'] = Buffer.byteLength(bodyText);
      const chunks = [];
      const sendUpstream = () =>
        new Promise((resolve) => {
          const upReq = http.request(
            { host: BACKEND_HOST, port: BACKEND_PORT, method: 'POST', path: rawUrl, headers, timeout: 40000 },
            (upRes) => {
              let size = 0;
              upRes.on('data', (c) => {
                size += c.length;
                if (size <= MAX_JSON_BODY) chunks.push(c);
              });
              upRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
              upRes.on('error', () => resolve(''));
            }
          );
          upReq.on('error', () => resolve(''));
          upReq.on('timeout', () => upReq.destroy());
          upReq.end(bodyText);
        });

      const upstreamText = await sendUpstream();
      let upstreamJson = null;
      try {
        upstreamJson = JSON.parse(upstreamText);
      } catch {
        upstreamJson = null;
      }

      if (!body || !upstreamJson || upstreamJson.code === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(upstreamText || JSON.stringify(upstreamJson || { code: 502, msg: 'bad gateway' }));
        return;
      }

      // 影视端失败（多为 HLS STRM 的 DirectLinkPullError）：尝试本地匹配源地址
      const itemGuid = String(body.item_guid || '');
      const mediaGuid = String(body.media_guid || '');
      const authorization = req.headers.authorization;
      if (!itemGuid || !mediaGuid) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(upstreamText);
        return;
      }
      const info = await mediaApi(
        '/v/api/v1/play/info',
        { item_guid: itemGuid, media_guid: mediaGuid, video_guid: '', ts: 0 },
        authorization
      );
      const infoData = info && info.code === 0 ? info.data : null;
      let match = null;
      const byMedia = await resolveSourceByMedia(mediaGuid, authorization);
      if (byMedia) match = { url: byMedia.url, matchedBy: `file:${byMedia.via}` };
      if (!match) match = resolveSourceUrl(infoData && infoData.item ? infoData.item : null);
      if (!match || !match.url) {
        log.warn(`play/play 失败且无法匹配源: ${upstreamJson.msg || upstreamJson.code} item=${itemGuid}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(upstreamText);
        return;
      }
      log.info(`play/play 改写为本地中转: ${match.matchedBy} -> ${match.url.slice(0, 120)}`);
      const synthetic = buildSyntheticPlayResponse(mediaGuid, (infoData && infoData.video_guid) || body.video_guid, match.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(synthetic));
    });
  }

  const server = http.createServer((req, res) => {
    let pathname = '/';
    let rawUrl = req.url || '/';
    try {
      pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
    } catch {
      pathname = '/';
    }
    try {
      if (authRequired() && rejectUnauthorized(req, res, pathname)) return;
      if (pathname.startsWith('/__strm/')) {
        handleRelay(req, res, pathname);
        return;
      }
      if (pathname === '/__strm/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'POST' && pathname === '/v/api/v1/stream') {
        handleStream(req, res, rawUrl);
        return;
      }
      if (req.method === 'POST' && pathname === '/v/api/v1/play/play') {
        handlePlayPlay(req, res, rawUrl);
        return;
      }
      proxyNormal(req, res, rawUrl);
    } catch (err) {
      log.error(`请求处理异常: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  // WebSocket 透传（影视 Web 可能使用）
  server.on('upgrade', (req, socket, head) => {
    try {
      if (authRequired() && !hasLibreTvSession(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const upSocket = require('net').connect(BACKEND_PORT, BACKEND_HOST, () => {
        const headers = Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        upSocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head && head.length) upSocket.write(head);
        socket.pipe(upSocket);
        upSocket.pipe(socket);
      });
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    } catch (err) {
      log.warn(`WebSocket 透传失败: ${err && err.message}`);
      socket.destroy();
    }
  });

  server.on('error', (err) => log.error(`影视代理监听失败: ${err && err.message}`));

  let stopped = false;
  return {
    start() {
      return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => {
          log.info(`已启动: http://0.0.0.0:${port} -> ${BACKEND_HOST}:${BACKEND_PORT}（鉴权: ${authRequired() ? 'LibreTV 会话' : '已关闭'}）`);
          resolve(true);
        });
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
    get server() {
      return server;
    },
    _internal: { normalizeTitle, titleMatch, signToken, verifyToken, rewritePlaylist, resolveSourceUrl, sourceUrlFromStrmPath, rewriteStreamResponse },
  };
}

module.exports = { createMediaProxy };
