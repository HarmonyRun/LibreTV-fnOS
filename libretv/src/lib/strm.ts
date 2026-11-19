/**
 * STRM 媒体库共享契约（客户端 / 服务端共用，纯函数，无 Node 依赖）。
 *
 * 数据格式与校验规则见 docs/ARCHITECTURE.md 第 4、8、9 节：
 * - config.json 由 Next 设置页写入、引擎只读；
 * - queue/job-<epochMs>-<6位随机>.json 由 Next 原子写入、引擎消费；
 * - 下发给前端的配置必须脱敏（密码类字段只返回 hasXxx 布尔）。
 */

export type StrmMediaType = 'movie' | 'tv';
export type StrmActionName = 'sync' | 'cleanup' | 'refresh' | 'migrate';
/** 队列任务类型：add 加入媒体库 / remove 从媒体库移除 / 其余为引擎动作 */
export type StrmJobAction = 'add' | 'remove' | StrmActionName;

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
  /** 索引 key（`sourceApiBase::vodId`）：移除时用于精确定位条目 */
  key: 512,
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

/**
 * POST /api/strm/remove 的入参：key 最精确（索引 key），
 * 没有 key 时用 title（可配 year / type / season）在引擎侧匹配资源目录。
 * season 只删除该季文件夹，dryRun 只统计不删除。
 */
export interface StrmRemovePayload {
  /** 索引 key（`sourceApiBase::vodId`），与 title 至少提供一个 */
  key?: string;
  /** 片名，与 key 至少提供一个；引擎侧按标题匹配资源目录 */
  title?: string;
  year?: string;
  type?: StrmMediaType;
  /** 1–99 的正整数：只移除该季（对应 Season 01 等目录），保留其它季 */
  season?: number;
  /** 只统计将删除的目录/文件，不实际删除 */
  dryRun?: boolean;
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
  /** 最近一个队列任务的结果概要（引擎写入；字段只做宽松读取） */
  lastResult?: StrmLastResult | null;
}

/** state.engine.lastResult：{ at, action, jobId, ok, error?, result? } */
export interface StrmLastResult {
  at?: string;
  action?: string;
  jobId?: string;
  ok?: boolean;
  error?: string;
  result?: unknown;
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

/** GET /api/strm/entries 的单行：由 strm-index.json 的索引条目投影而来 */
export interface StrmEntry {
  key: string;
  title: string;
  year: string;
  type: StrmMediaType;
  sourceName: string;
  /** 该条目当前索引到的 .strm 文件数 */
  strmCount: number;
  /** 资源根目录名（strmPaths[0] 相对 STRM 根目录的第一层目录），未知时为空 */
  resourceRoot: string;
  lastSyncedAt: string;
  lastError: string;
  consecutiveFailures: number;
}

export interface StrmEntriesResponse {
  ok: true;
  total: number;
  entries: StrmEntry[];
}

export interface StrmRemoveResponse {
  ok: true;
  jobId: string;
  action: 'remove';
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

/**
 * 校验 /api/strm/remove 的入参：
 * - key / title 至少提供一个（key 最精确，title 走引擎侧标题匹配）；
 * - year / type / season 为可选精确条件，season 为 1–99 正整数；
 * - dryRun 仅为引擎侧的试运行开关（当前 UI 不使用）。
 */
export function validateRemovePayload(input: unknown): ValidationResult<StrmRemovePayload> {
  if (!isPlainRecord(input)) return { ok: false, error: '请求格式错误' };

  const key = readScalar(input.key);
  if (key.length > STRM_LIMITS.key) {
    return { ok: false, error: `key 过长（最多 ${STRM_LIMITS.key} 字符）` };
  }
  const titleField = stringField(input, 'title', STRM_LIMITS.vodName, 'title');
  if (!titleField.ok) return titleField;
  const title = titleField.value;
  if (!key && !title) return { ok: false, error: 'key 与 title 至少需要提供一个' };

  const yearField = stringField(input, 'year', STRM_LIMITS.vodYear, 'year');
  if (!yearField.ok) return yearField;

  const payload: StrmRemovePayload = { key, title, year: yearField.value };

  if (input.type !== undefined && input.type !== null) {
    const typeRaw = typeof input.type === 'string' ? input.type.trim() : '';
    if (typeRaw !== 'movie' && typeRaw !== 'tv') {
      return { ok: false, error: 'type 只能是 movie 或 tv' };
    }
    payload.type = typeRaw;
  }

  if (input.season !== undefined && input.season !== null && input.season !== '') {
    const season =
      typeof input.season === 'number'
        ? input.season
        : typeof input.season === 'string' && input.season.trim()
          ? Number(input.season.trim())
          : NaN;
    if (!Number.isInteger(season) || season < 1 || season > 99) {
      return { ok: false, error: 'season 必须是 1–99 之间的正整数' };
    }
    payload.season = season;
  }

  if (input.dryRun !== undefined && input.dryRun !== null) {
    if (typeof input.dryRun !== 'boolean') return { ok: false, error: 'dryRun 必须是布尔值' };
    payload.dryRun = input.dryRun;
  }

  return { ok: true, value: payload };
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

function readCount(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

/** 数组长度，用于兼容部分实现返回目录/条目数组而不是计数 */
function readArrayCount(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  return Array.isArray(value) ? value.length : null;
}

/**
 * 移除任务结果的可读摘要。
 * 引擎 state.engine.lastResult.result 的契约为：
 * { ok, mode: 'resource'|'season', dirsRemoved, deletedFiles, entriesRemoved, prunedEntries, failed }
 * （state.json 只放计数，不放目录路径）；同时兼容旧实现返回数组的写法。
 * 空对象或无法识别时返回空字符串，由调用方回退到通用文案。
 */
export function formatRemoveResult(result: unknown): string {
  const r = asRecord(result);
  if (Object.keys(r).length === 0) return '';

  const dirs = readCount(r, 'dirsRemoved') ?? readArrayCount(r, 'deletedDirs') ?? readArrayCount(r, 'dirs') ?? 0;
  const files = readCount(r, 'deletedFiles') ?? readCount(r, 'totalFiles') ?? readCount(r, 'files') ?? 0;
  const entries = readCount(r, 'entriesRemoved') ?? readArrayCount(r, 'removedEntries') ?? 0;
  const pruned = readCount(r, 'prunedEntries') ?? 0;
  const failed = readCount(r, 'failed') ?? readArrayCount(r, 'failed') ?? 0;

  const parts: string[] = [];
  if (r.dryRun === true) parts.push('试运行');
  parts.push(`已移除 ${dirs} 个目录（${files} 个文件），索引移除 ${entries} 条`);
  if (pruned > 0) parts.push(`${pruned} 条索引仅移除该季`);
  if (failed > 0) parts.push(`${failed} 个目录删除失败`);
  return parts.join(' · ');
}

/**
 * 换源迁移任务结果的可读摘要。
 * 引擎 state.engine.lastResult.result 的契约为：
 * { ok, dryRun, checked, migrated, skipped, failed, entries: [{ title, from, to, files }] }
 * （entries 明细不入摘要，避免 toast 过长）；字段缺失按 0 处理。
 * 空对象或无法识别时返回空字符串，由调用方回退到通用文案。
 */
export function formatMigrateResult(result: unknown): string {
  const r = asRecord(result);
  if (Object.keys(r).length === 0) return '';

  const migrated = readCount(r, 'migrated') ?? 0;
  const skipped = readCount(r, 'skipped') ?? 0;
  const failed = readCount(r, 'failed') ?? 0;

  const parts: string[] = [];
  if (r.dryRun === true) parts.push('试运行');
  parts.push(`迁移 ${migrated} 条（跳过 ${skipped}，失败 ${failed}）`);
  return parts.join(' · ');
}
