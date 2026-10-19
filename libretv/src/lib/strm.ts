/**
 * STRM 媒体库共享契约（客户端 / 服务端共用，纯函数，无 Node 依赖）。
 *
 * 数据格式与校验规则见 docs/ARCHITECTURE.md 第 4、8、9 节：
 * - config.json 由 Next 设置页写入、引擎只读；
 * - queue/job-<epochMs>-<6位随机>.json 由 Next 原子写入、引擎消费；
 * - 下发给前端的配置必须脱敏（密码类字段只返回 hasXxx 布尔）。
 */

export type StrmMediaType = 'movie' | 'tv';
export type StrmActionName = 'sync' | 'cleanup' | 'refresh';
export type StrmJobAction = 'add' | StrmActionName;

export const DEFAULT_SYNC_INTERVAL_HOURS = 6;
export const DEFAULT_FNV_BASE_URL = 'http://127.0.0.1:5666';
export const DEFAULT_FNV_APP_NAME = 'trimemedia-web';
export const SYNC_INTERVAL_MIN_HOURS = 1;
export const SYNC_INTERVAL_MAX_HOURS = 168;

/** 各字段长度上限（同时用于服务端校验与前端提示） */
export const STRM_LIMITS = {
  strmRoot: 512,
  libraryName: 128,
  username: 128,
  password: 256,
  secretString: 512,
  apiKey: 512,
  baseUrl: 512,
  appName: 64,
  sourceApiBase: 512,
  sourceDetailBase: 512,
  sourceName: 128,
  vodId: 64,
  vodName: 256,
  vodYear: 16,
} as const;

// —— 配置（对外脱敏视图） ——

export interface StrmFnvConfig {
  enabled: boolean;
  baseUrl: string;
  appName: string;
  username: string;
  libraryName: string;
  /** 以下密码类字段只暴露「是否已配置」，原文永不下发 */
  hasPassword: boolean;
  hasSecretString: boolean;
  hasApiKey: boolean;
}

export interface StrmConfigPublic {
  strmRoot: string;
  syncIntervalHours: number;
  movieLibraryName: string;
  tvLibraryName: string;
  /** 访问密码是否已配置（对应 config.password） */
  hasPassword: boolean;
  fnv: StrmFnvConfig;
}

/** POST /api/strm/config 的部分更新体：密码类字段传空字符串表示「保持原值」 */
export interface StrmConfigPatch {
  strmRoot?: string;
  syncIntervalHours?: number;
  movieLibraryName?: string;
  tvLibraryName?: string;
  password?: string;
  fnv?: {
    enabled?: boolean;
    baseUrl?: string;
    appName?: string;
    username?: string;
    password?: string;
    secretString?: string;
    apiKey?: string;
    libraryName?: string;
  };
}

// —— 队列任务 ——

export interface StrmAddPayload {
  sourceApiBase: string;
  sourceName: string;
  sourceDetailBase: string;
  vodId: string;
  vodName: string;
  vodYear: string;
  type: StrmMediaType;
}

export interface StrmRefreshPayload {
  sourceApiBase: string;
  vodId: string;
}

export interface StrmJob<TPayload = Record<string, unknown>> {
  id: string;
  createdAt: string;
  action: StrmJobAction;
  payload: TPayload;
}

/** 队列文件名规范：job-<epochMs>-<6位随机>.json */
export const JOB_FILE_RE = /^job-\d{10,}-[a-z0-9]{6}\.json$/;

// —— 引擎状态 / 索引概要（只做宽松读取，字段缺失不视为错误） ——

export interface StrmSyncResult {
  checked?: number;
  updated?: number;
  deleted?: number;
  orphansDeleted?: number;
  errors?: number;
}

export interface StrmEngineState {
  pid?: number;
  startedAt?: string;
  lastTickAt?: string;
  lastSyncAt?: string;
  lastSyncResult?: StrmSyncResult;
  queuePending?: number;
  processingJob?: string;
}

export interface StrmFnvState {
  configured?: boolean;
  lastOkAt?: string;
  lastError?: string;
  lastMode?: string;
}

export interface StrmState {
  engine?: StrmEngineState;
  fnv?: StrmFnvState;
  paths?: { strmRoot?: string; indexCount?: number };
}

export interface StrmIndexSummary {
  count: number;
  /** 各类型条目数，如 { movie: 3, tv: 1 } */
  types: Record<string, number>;
}

export interface StrmStatusResponse {
  state: StrmState | null;
  indexSummary: StrmIndexSummary;
  /** engine.log 末尾若干行（不含换行） */
  log: string[];
  config: StrmConfigPublic;
  /** STRM 根目录当前是否可写（未配置 / 不存在均返回 false） */
  strmRootWritable: boolean;
  /** queue/ 下待处理任务数 */
  queuePending: number;
}

export interface StrmAddResponse {
  ok: true;
  jobId: string;
}

export interface StrmActionResponse {
  ok: true;
  jobId: string;
  action: StrmActionName;
  /** sync 去重命中已有任务时为 true */
  existing?: boolean;
}

export interface StrmErrorResponse {
  error: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

// —— 基础工具 ——

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 把数字/字符串统一成字符串（用于 vodId 等允许数字入参的字段） */
function readScalar(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function stringField(
  raw: Record<string, unknown>,
  key: string,
  maxLength: number,
  label: string,
  required = false
): ValidationResult<string> {
  const value = raw[key];
  if (value === undefined || value === null) {
    return required ? { ok: false, error: `${label}不能为空` } : { ok: true, value: '' };
  }
  if (typeof value !== 'string') return { ok: false, error: `${label}必须是字符串` };
  const trimmed = value.trim();
  if (required && !trimmed) return { ok: false, error: `${label}不能为空` };
  if (trimmed.length > maxLength) return { ok: false, error: `${label}过长（最多 ${maxLength} 字符）` };
  return { ok: true, value: trimmed };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(value);
}

// —— 队列任务入参校验 ——

/** 校验 /api/strm/add 的入参（契约第 8 节） */
export function validateAddPayload(input: unknown): ValidationResult<StrmAddPayload> {
  if (!isPlainRecord(input)) return { ok: false, error: '请求格式错误' };

  const sourceApiBase = readScalar(input.sourceApiBase);
  if (!isHttpUrl(sourceApiBase)) return { ok: false, error: 'sourceApiBase 必须是 http(s) 地址' };
  if (sourceApiBase.length > STRM_LIMITS.sourceApiBase) {
    return { ok: false, error: 'sourceApiBase 过长' };
  }

  const vodId = readScalar(input.vodId);
  if (!vodId) return { ok: false, error: 'vodId 不能为空' };
  if (vodId.length > STRM_LIMITS.vodId) return { ok: false, error: 'vodId 过长（最多 64 字符）' };

  const typeRaw = typeof input.type === 'string' ? input.type.trim() : '';
  if (typeRaw !== 'movie' && typeRaw !== 'tv') {
    return { ok: false, error: 'type 只能是 movie 或 tv' };
  }

  const sourceName = stringField(input, 'sourceName', STRM_LIMITS.sourceName, 'sourceName');
  if (!sourceName.ok) return sourceName;
  const vodName = stringField(input, 'vodName', STRM_LIMITS.vodName, 'vodName');
  if (!vodName.ok) return vodName;
  const vodYear = stringField(input, 'vodYear', STRM_LIMITS.vodYear, 'vodYear');
  if (!vodYear.ok) return vodYear;
  const sourceDetailBase = stringField(
    input,
    'sourceDetailBase',
    STRM_LIMITS.sourceDetailBase,
    'sourceDetailBase'
  );
  if (!sourceDetailBase.ok) return sourceDetailBase;
  if (sourceDetailBase.value && !isHttpUrl(sourceDetailBase.value)) {
    return { ok: false, error: 'sourceDetailBase 必须是 http(s) 地址或留空' };
  }

  return {
    ok: true,
    value: {
      sourceApiBase,
      sourceName: sourceName.value,
      sourceDetailBase: sourceDetailBase.value,
      vodId,
      vodName: vodName.value,
      vodYear: vodYear.value,
      type: typeRaw,
    },
  };
}

/** 校验 /api/strm/action refresh 的入参（只需源地址与影片 ID） */
export function validateRefreshPayload(input: unknown): ValidationResult<StrmRefreshPayload> {
  if (!isPlainRecord(input)) return { ok: false, error: '请求格式错误' };
  const sourceApiBase = readScalar(input.sourceApiBase);
  if (!isHttpUrl(sourceApiBase)) return { ok: false, error: 'sourceApiBase 必须是 http(s) 地址' };
  if (sourceApiBase.length > STRM_LIMITS.sourceApiBase) {
    return { ok: false, error: 'sourceApiBase 过长' };
  }
  const vodId = readScalar(input.vodId);
  if (!vodId) return { ok: false, error: 'vodId 不能为空' };
  if (vodId.length > STRM_LIMITS.vodId) return { ok: false, error: 'vodId 过长（最多 64 字符）' };
  return { ok: true, value: { sourceApiBase, vodId } };
}

// —— 配置读取 / 脱敏 / 写入校验 ——

/** 规范化同步间隔：合法（1–168 整数）返回数字，否则 null */
export function normalizeSyncInterval(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n < SYNC_INTERVAL_MIN_HOURS || n > SYNC_INTERVAL_MAX_HOURS) return null;
  return n;
}

/**
 * 规范化 STRM 根目录：只接受绝对路径，按 POSIX 规则消除 `.` / `..` 与重复斜杠。
 * 非法（相对路径、含控制字符、`..` 越界）返回 null。
 */
export function normalizeStrmRoot(raw: string): string | null {
  const input = raw.trim();
  if (!input.startsWith('/')) return null;
  if (/[\u0000-\u001f]/.test(input)) return null;
  const parts: string[] = [];
  for (const segment of input.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

const FORBIDDEN_STRM_ROOTS: { pattern: RegExp; label: string }[] = [
  { pattern: /^\/vol[^/]*\/@app[^/]*(?:\/|$)/, label: '/vol*/@app*（应用内部目录）' },
  { pattern: /^\/var\/apps(?:\/|$)/, label: '/var/apps（应用内部目录）' },
  { pattern: /^\/(?:usr|etc|proc|sys)(?:\/|$)/, label: '系统目录 /usr、/etc、/proc、/sys' },
];

/** 命中禁止目录时返回说明，否则 null（入参须为 normalizeStrmRoot 的结果） */
export function forbiddenStrmRootReason(normalizedRoot: string): string | null {
  for (const item of FORBIDDEN_STRM_ROOTS) {
    if (item.pattern.test(normalizedRoot)) return item.label;
  }
  return null;
}

/**
 * 脱敏配置视图：把 password / fnv.password / fnv.secretString / fnv.apiKey
 * 替换为 hasPassword / hasSecretString / hasApiKey 布尔，缺失字段回退为默认值。
 */
export function publicStrmConfig(raw: unknown): StrmConfigPublic {
  const cfg = asRecord(raw);
  const fnv = asRecord(cfg.fnv);
  return {
    strmRoot: readString(cfg.strmRoot).trim(),
    syncIntervalHours: normalizeSyncInterval(cfg.syncIntervalHours) ?? DEFAULT_SYNC_INTERVAL_HOURS,
    movieLibraryName: readString(cfg.movieLibraryName).trim(),
    tvLibraryName: readString(cfg.tvLibraryName).trim(),
    hasPassword: readString(cfg.password).length > 0,
    fnv: {
      enabled: fnv.enabled === true,
      baseUrl: readString(fnv.baseUrl).trim() || DEFAULT_FNV_BASE_URL,
      appName: readString(fnv.appName).trim() || DEFAULT_FNV_APP_NAME,
      username: readString(fnv.username),
      libraryName: readString(fnv.libraryName).trim(),
      hasPassword: readString(fnv.password).length > 0,
      hasSecretString: readString(fnv.secretString).length > 0,
      hasApiKey: readString(fnv.apiKey).length > 0,
    },
  };
}

/**
 * 合并 POST /api/strm/config 的部分更新到现有配置。
 * - 未出现的字段保持原值（含 port / sources 等引擎侧字段）；
 * - 密码类字段传空字符串表示不修改；
 * - strmRoot / syncIntervalHours / fnv.baseUrl 等按契约校验。
 */
export function mergeStrmConfig(current: unknown, patch: unknown): ValidationResult<Record<string, unknown>> {
  if (!isPlainRecord(patch)) return { ok: false, error: '请求格式错误' };

  const base = asRecord(current);
  const next: Record<string, unknown> = { ...base, fnv: { ...asRecord(base.fnv) } };
  const fnv = next.fnv as Record<string, unknown>;

  if ('strmRoot' in patch) {
    const rawRoot = patch.strmRoot;
    if (typeof rawRoot !== 'string') return { ok: false, error: 'STRM 根目录必须是字符串' };
    const normalized = normalizeStrmRoot(rawRoot);
    if (!normalized) return { ok: false, error: 'STRM 根目录必须是绝对路径（以 / 开头）' };
    if (rawRoot.trim().length > STRM_LIMITS.strmRoot) {
      return { ok: false, error: `STRM 根目录过长（最多 ${STRM_LIMITS.strmRoot} 字符）` };
    }
    if (normalized === '/') return { ok: false, error: 'STRM 根目录不能是文件系统根目录 /' };
    const forbidden = forbiddenStrmRootReason(normalized);
    if (forbidden) return { ok: false, error: `STRM 根目录不能位于 ${forbidden}` };
    next.strmRoot = normalized;
  }

  if ('syncIntervalHours' in patch) {
    const hours = normalizeSyncInterval(patch.syncIntervalHours);
    if (hours === null) return { ok: false, error: '同步间隔需为 1–168 之间的整数小时' };
    next.syncIntervalHours = hours;
  }

  for (const key of ['movieLibraryName', 'tvLibraryName'] as const) {
    if (!(key in patch)) continue;
    const field = stringField(patch, key, STRM_LIMITS.libraryName, key);
    if (!field.ok) return field;
    next[key] = field.value;
  }

  if ('password' in patch) {
    const value = patch.password;
    if (typeof value !== 'string') return { ok: false, error: '访问密码必须是字符串' };
    if (value.length > STRM_LIMITS.password) {
      return { ok: false, error: `访问密码过长（最多 ${STRM_LIMITS.password} 字符）` };
    }
    // 空字符串 = 保持原密码不变
    if (value !== '') next.password = value;
  }

  if ('fnv' in patch) {
    const fnvPatch = patch.fnv;
    if (fnvPatch !== undefined) {
      if (!isPlainRecord(fnvPatch)) return { ok: false, error: 'fnv 配置格式错误' };

      if ('enabled' in fnvPatch) {
        if (typeof fnvPatch.enabled !== 'boolean') return { ok: false, error: 'fnv.enabled 必须是布尔值' };
        fnv.enabled = fnvPatch.enabled;
      }

      if ('baseUrl' in fnvPatch) {
        const field = stringField(fnvPatch, 'baseUrl', STRM_LIMITS.baseUrl, '飞牛影视 base_url');
        if (!field.ok) return field;
        if (field.value && !isHttpUrl(field.value)) {
          return { ok: false, error: '飞牛影视 base_url 必须是 http(s) 地址或留空' };
        }
        fnv.baseUrl = field.value;
      }

      if ('appName' in fnvPatch) {
        const field = stringField(fnvPatch, 'appName', STRM_LIMITS.appName, '飞牛影视 app_name');
        if (!field.ok) return field;
        fnv.appName = field.value || DEFAULT_FNV_APP_NAME;
      }

      if ('username' in fnvPatch) {
        const field = stringField(fnvPatch, 'username', STRM_LIMITS.username, '飞牛影视用户名');
        if (!field.ok) return field;
        fnv.username = field.value;
      }

      if ('libraryName' in fnvPatch) {
        const field = stringField(fnvPatch, 'libraryName', STRM_LIMITS.libraryName, '飞牛影视媒体库名称');
        if (!field.ok) return field;
        fnv.libraryName = field.value;
      }

      const secretLimits: Record<'password' | 'secretString' | 'apiKey', number> = {
        password: STRM_LIMITS.password,
        secretString: STRM_LIMITS.secretString,
        apiKey: STRM_LIMITS.apiKey,
      };
      for (const key of Object.keys(secretLimits) as (keyof typeof secretLimits)[]) {
        if (!(key in fnvPatch)) continue;
        const value = fnvPatch[key];
        if (typeof value !== 'string') {
          return { ok: false, error: `fnv.${key} 必须是字符串` };
        }
        if (value.length > secretLimits[key]) {
          return { ok: false, error: `fnv.${key} 过长（最多 ${secretLimits[key]} 字符）` };
        }
        // 空字符串 = 保持原值不变
        if (value !== '') fnv[key] = value;
      }
    }
  }

  return { ok: true, value: next };
}

// —— 任务命名 / 索引概要 / 日志 ——

function randomHex6(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(3);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 8).padEnd(6, '0');
}

/** 生成队列任务 ID / 文件名主干：job-<epochMs>-<6位随机>（契约 4.2） */
export function makeJobId(now = Date.now(), randomSource?: () => string): string {
  const suffix = (randomSource?.() ?? randomHex6())
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6)
    .padEnd(6, '0');
  return `job-${now}-${suffix}`;
}

/** 容错汇总 strm-index.json：缺失/损坏/结构异常都返回 0 而不是抛错 */
export function summarizeIndex(raw: unknown): StrmIndexSummary {
  const entries = asRecord(asRecord(raw).entries);
  const types: Record<string, number> = {};
  let count = 0;
  for (const entry of Object.values(entries)) {
    count += 1;
    const type = readString(asRecord(entry).type) || 'unknown';
    types[type] = (types[type] ?? 0) + 1;
  }
  return { count, types };
}

/** 取日志末尾若干行（忽略空行） */
export function tailLogLines(logText: string, maxLines = 50): string[] {
  if (!logText) return [];
  const lines = logText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-Math.max(0, maxLines));
}

export interface FnvStatusView {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
  detail: string;
}

/** 把 state.json 的 fnv 段翻译成设置页可读的状态（已配置 / 降级 / 错误 / 未配置） */
export function fnvStatus(state: unknown): FnvStatusView {
  const fnv = asRecord(asRecord(state).fnv);
  const configured = fnv.configured === true;
  const lastMode = readString(fnv.lastMode);
  const lastError = readString(fnv.lastError);

  if (!configured) {
    return { label: '未配置', tone: 'muted', detail: '未启用自动刷新或缺少飞牛影视凭据，将于下次同步时跳过' };
  }
  if (lastMode === 'fallback') {
    return {
      label: '降级',
      tone: 'warn',
      detail: lastError || '调用飞牛影视接口失败，已改用以文件时间戳触发扫描',
    };
  }
  if (lastError && lastMode !== 'api') {
    return { label: '错误', tone: 'error', detail: lastError };
  }
  return {
    label: '已配置',
    tone: 'ok',
    detail: lastMode === 'api' ? '最近一次 API 刷新成功' : '等待首次自动刷新',
  };
}

/** 最近一次同步结果的单行摘要（字段缺失按 0 处理） */
export function formatSyncResult(result: unknown): string {
  const r = asRecord(result);
  if (Object.keys(r).length === 0) return '';
  const num = (key: keyof StrmSyncResult): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return `检查 ${num('checked')} · 更新 ${num('updated')} · 删除 ${num('deleted')} · 孤儿 ${num('orphansDeleted')} · 错误 ${num('errors')}`;
}
