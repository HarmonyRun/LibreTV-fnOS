'use strict';

/**
 * 飞牛影视签名密钥解析（secret_string / api_key）。
 *
 * 背景（docs/NAS-RECON.md §4.4）：这两个值不是用户凭据，而是随影视前端版本下发的
 * **全局常量**，硬编码在媒体前端静态资源 bundle 中。用户只需要在设置里填媒体账号密码。
 *
 * 三级来源（不改契约字段）：
 *   a. config.fnv.secretString / apiKey 非空 → 直接使用（允许用户覆盖）；
 *   b. 为空 → 从本机媒体前端 bundle（默认
 *      /usr/local/apps/@appcenter/trim.media/static/assets/*.js，取最大/最新文件）提取：
 *        - secret 常量：secret_string / secret 赋值，或 32/40 位左右的全局常量；
 *        - api_key 常量：api_key/apiKey 赋值，或前端 `vh` 的字节数组 XOR 169 解码出的 UUID；
 *   c. 仍提取不到 → 使用内置默认常量（随本应用版本固定，可被用户配置覆盖）。
 *
 * 解析结果只用于签名；任何日志都不得输出密钥原文。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_BUNDLE_DIR = '/usr/local/apps/@appcenter/trim.media/static/assets';
// 影视 0.9.8-1 前端 bundle 实测常量（docs/NAS-RECON.md §4.2）
const BUILTIN_SECRET_STRING = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const BUILTIN_API_KEY = '16CCEB3D-AB42-077D-36A1-F355324E4237';
const BUNDLE_FILE_LIMIT = 12;
const BUNDLE_FILE_MAX_BYTES = 8 * 1024 * 1024;
const XOR_KEY = 169;

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const SECRET_ASSIGN_RE =
  /(?:secret[_-]?string|secretString|SECRET_STRING|secret)\s*[:=]\s*["'`]([A-Za-z0-9]{16,64})["'`]/g;
const API_KEY_ASSIGN_RE =
  /(?:api[_-]?key|apiKey|API_KEY|apikey)\s*[:=]\s*["'`]([A-Za-z0-9-]{16,64})["'`]/g;
const GENERIC_TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z0-9]{28,40}(?![A-Za-z0-9])/g;
// 前端 XOR 数组可能是普通数组或 ()=>[...] 返回，统一抓取 20~120 个数字的数组
const NUMERIC_ARRAY_RE = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){20,120}\s*\]/g;

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 可读的密钥来源标签（组合 config / bundle / builtin） */
function combineSource(sources) {
  const secret = sources.secretString;
  const apiKey = sources.apiKey;
  if (secret === 'config' && apiKey === 'config') return 'config';
  if (secret === 'builtin' && apiKey === 'builtin') return 'builtin';
  if (secret === 'bundle' || apiKey === 'bundle') return 'bundle';
  return 'mixed';
}

/** 列出媒体前端 assets 下候选 JS 文件（按体积降序、同体积按 mtime 降序，取前 N 个） */
function listBundleFiles(bundleDir) {
  const dir = asString(bundleDir) || DEFAULT_BUNDLE_DIR;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:js|mjs)$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > BUNDLE_FILE_MAX_BYTES) continue;
    files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs);
  return files.slice(0, BUNDLE_FILE_LIMIT);
}

function decodeXor169(numbers) {
  try {
    return String.fromCharCode(...numbers.map((n) => n ^ XOR_KEY));
  } catch {
    return '';
  }
}

function parseNumericArray(source) {
  return source
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
}

/**
 * 从 bundle 文本提取 api_key：
 *   1) api_key/apiKey 直接赋值（UUID 或 16+ 字符串）
 *   2) 前端字节数组 XOR 169 解码后等于 UUID 形式
 */
function extractApiKeyFromText(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return '';

  let firstAssigned = '';
  for (const match of source.matchAll(API_KEY_ASSIGN_RE)) {
    const value = match[1].trim();
    if (UUID_RE.test(value)) return value;
    if (!firstAssigned && value.length >= 16) firstAssigned = value;
  }

  for (const match of source.matchAll(NUMERIC_ARRAY_RE)) {
    const numbers = parseNumericArray(match[0]);
    if (numbers.length < 20 || numbers.length > 120) continue;
    const decoded = decodeXor169(numbers);
    if (UUID_RE.test(decoded)) return decoded;
  }
  return firstAssigned;
}

function isPlausibleSecret(value) {
  if (!value) return false;
  if (!/^[A-Za-z0-9]{16,64}$/.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  // 排除 32 位十六进制哈希（md5 等）
  if (/^[0-9a-f]+$/i.test(value)) return false;
  return true;
}

/**
 * 从 bundle 文本提取 secret：
 *   1) secret_string/secret 赋值；
 *   2) 无明确赋值时，在 28~40 位全局常量中优先选择上下文含 secret/authx/nonce/timestamp
 *      的候选；若全文件只有一个可信候选也直接采用。多个候选且无上下文时放弃（用内置常量）。
 */
function extractSecretFromText(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return '';

  let firstAssigned = '';
  for (const match of source.matchAll(SECRET_ASSIGN_RE)) {
    const value = match[1].trim();
    if (isPlausibleSecret(value)) return value;
    if (!firstAssigned) firstAssigned = value;
  }

  const candidates = new Map();
  let candidateCount = 0;
  for (const match of source.matchAll(GENERIC_TOKEN_RE)) {
    const token = match[0];
    if (!isPlausibleSecret(token)) continue;
    candidateCount += 1;
    const start = Math.max(0, (match.index || 0) - 160);
    const context = source.slice(start, (match.index || 0) + token.length + 160);
    let score = 0;
    if (/secret|authx|nonce|timestamp|sign/i.test(context)) score += 3;
    if (/[A-Z]/.test(token) && /[a-z]/.test(token)) score += 1;
    const current = candidates.get(token);
    if (!current) candidates.set(token, { token, score, count: 1 });
    else {
      current.count += 1;
      if (score > current.score) current.score = score;
    }
  }

  const unique = [...candidates.values()];
  if (unique.length === 1) return unique[0].token;
  if (unique.length > 1) {
    unique.sort((a, b) => b.score - a.score || b.count - a.count);
    if (unique[0].score >= 3) return unique[0].token;
  }
  return firstAssigned;
}

/** 从 bundle 目录提取两个常量；返回 {secretString, apiKey, bundleFiles, scanned, dir} */
function extractSecretsFromBundle(bundleDir) {
  const dir = asString(bundleDir) || DEFAULT_BUNDLE_DIR;
  const files = listBundleFiles(dir);
  let secretString = '';
  let apiKey = '';
  const used = [];
  for (const file of files) {
    if (secretString && apiKey) break;
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    if (!secretString) {
      const value = extractSecretFromText(text);
      if (value) {
        secretString = value;
        if (!used.includes(file.path)) used.push(file.path);
      }
    }
    if (!apiKey) {
      const value = extractApiKeyFromText(text);
      if (value) {
        apiKey = value;
        if (!used.includes(file.path)) used.push(file.path);
      }
    }
  }
  return { secretString, apiKey, bundleFiles: used, scanned: files.length, dir };
}

/**
 * 解析最终生效的签名密钥与来源。
 * @param {object} options
 * @param {boolean} [options.enabled=true]
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {string} [options.secretString] config 显式覆盖
 * @param {string} [options.apiKey] config 显式覆盖
 * @param {string} [options.bundleDir] 覆盖 bundle 目录（单测注入）
 * @returns {{secretString:string, apiKey:string, sources:{secretString:string, apiKey:string},
 *   source:string, configured:boolean, bundleDir:string, bundleFiles:string[], scanned:number, error:string}}
 */
function resolveFnvSecrets(options = {}) {
  const enabled = options.enabled !== false;
  const username = asString(options.username);
  const password = typeof options.password === 'string' ? options.password : '';
  const bundleDir = asString(options.bundleDir) || process.env.LIBRETV_FNV_BUNDLE_DIR || DEFAULT_BUNDLE_DIR;
  const result = {
    secretString: '',
    apiKey: '',
    sources: { secretString: '', apiKey: '' },
    source: 'none',
    configured: false,
    bundleDir,
    bundleFiles: [],
    scanned: 0,
    error: '',
  };

  // 未启用 / 缺媒体账号密码：不读取 bundle，直接视为未配置
  if (!enabled || !username || !password) {
    return result;
  }

  const configuredSecret = asString(options.secretString);
  const configuredApiKey = asString(options.apiKey);
  if (configuredSecret) {
    result.secretString = configuredSecret;
    result.sources.secretString = 'config';
  }
  if (configuredApiKey) {
    result.apiKey = configuredApiKey;
    result.sources.apiKey = 'config';
  }

  if (!result.secretString || !result.apiKey) {
    try {
      const bundle = extractSecretsFromBundle(bundleDir);
      result.scanned = bundle.scanned;
      result.bundleFiles = bundle.bundleFiles;
      if (!result.secretString && bundle.secretString) {
        result.secretString = bundle.secretString;
        result.sources.secretString = 'bundle';
      }
      if (!result.apiKey && bundle.apiKey) {
        result.apiKey = bundle.apiKey;
        result.sources.apiKey = 'bundle';
      }
    } catch (err) {
      result.error = (err && err.message) || String(err);
    }
  }

  // 兜底内置常量（随影视前端版本固定，可被 config 覆盖）
  if (!result.secretString) {
    result.secretString = BUILTIN_SECRET_STRING;
    result.sources.secretString = 'builtin';
  }
  if (!result.apiKey) {
    result.apiKey = BUILTIN_API_KEY;
    result.sources.apiKey = 'builtin';
  }

  result.source = combineSource(result.sources);
  result.configured = Boolean(enabled && username && password && result.secretString && result.apiKey);
  return result;
}

module.exports = {
  DEFAULT_BUNDLE_DIR,
  BUILTIN_SECRET_STRING,
  BUILTIN_API_KEY,
  BUNDLE_FILE_LIMIT,
  BUNDLE_FILE_MAX_BYTES,
  XOR_KEY,
  combineSource,
  listBundleFiles,
  decodeXor169,
  extractApiKeyFromText,
  extractSecretFromText,
  extractSecretsFromBundle,
  resolveFnvSecrets,
};
