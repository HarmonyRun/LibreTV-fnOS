import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  isPlainRecord,
  makeJobId,
  publicStrmConfig,
  summarizeIndex,
  tailLogLines,
  type StrmConfigPublic,
  type StrmIndexSummary,
  type StrmJob,
  type StrmJobAction,
  type StrmState,
  type StrmStatusResponse,
} from './strm';

/**
 * STRM 服务端数据层（仅 Route Handler 使用）：
 * 负责契约第 4 节的 var/ 数据目录解析、config.json 原子读写、队列任务写入，
 * 以及 state.json / strm-index.json / engine.log 的容错读取。
 */

/** 数据目录解析顺序：显式 LIBRETV_DATA_DIR → fnOS TRIM_PKGVAR → 本地 var/ */
export function getDataDir(): string {
  return process.env.LIBRETV_DATA_DIR || process.env.TRIM_PKGVAR || path.join(process.cwd(), 'var');
}

export interface StrmDataPaths {
  dir: string;
  config: string;
  index: string;
  state: string;
  log: string;
  queue: string;
}

export function getDataPaths(): StrmDataPaths {
  const dir = getDataDir();
  return {
    dir,
    config: path.join(dir, 'config.json'),
    index: path.join(dir, 'strm-index.json'),
    state: path.join(dir, 'state.json'),
    log: path.join(dir, 'engine.log'),
    queue: path.join(dir, 'queue'),
  };
}

/** 解析 JSON；文件缺失 / 内容损坏 / 权限不足均返回 null，由调用方回退默认值 */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 原子写 JSON：先写同目录临时文件，再 rename 覆盖（契约 4.2 / 4.3） */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  );
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// —— config.json ——

export async function readConfigRaw(): Promise<Record<string, unknown>> {
  const raw = await readJsonFile(getDataPaths().config);
  return isPlainRecord(raw) ? raw : {};
}

export async function writeConfigRaw(config: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(getDataPaths().config, config);
}

export async function readConfigPublic(): Promise<StrmConfigPublic> {
  return publicStrmConfig(await readConfigRaw());
}

// —— state.json / strm-index.json / engine.log ——

export async function readState(): Promise<StrmState | null> {
  const raw = await readJsonFile(getDataPaths().state);
  return isPlainRecord(raw) ? (raw as StrmState) : null;
}

export async function readIndexSummary(): Promise<StrmIndexSummary> {
  return summarizeIndex(await readJsonFile(getDataPaths().index));
}

/** 只读日志末尾 256KB 再取末 N 行：日志上限 2MB，避免为 50 行把整份读进内存 */
const LOG_TAIL_BYTES = 256 * 1024;

export async function readLogTail(maxLines = 50): Promise<string[]> {
  const file = getDataPaths().log;
  let handle: FileHandle | undefined;
  try {
    const stat = await fs.stat(file);
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return [];
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    // 起始位置可能落在多字节字符或某行中间：丢弃第一段残行
    if (start > 0) text = text.replace(/^[^\n]*\n?/, '');
    return tailLogLines(text, maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** STRM 根目录是否可写（未配置 / 不存在均返回 false） */
export async function isStrmRootWritable(strmRoot: string): Promise<boolean> {
  const root = strmRoot.trim();
  if (!root) return false;
  try {
    await fs.access(root, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// —— queue/ ——

/** 读取 queue/ 下所有待处理任务；损坏的任务文件跳过，不影响其余条目 */
export async function readQueueJobs(): Promise<StrmJob[]> {
  const dir = getDataPaths().queue;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jobs: StrmJob[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const raw = await readJsonFile(path.join(dir, name));
    if (!isPlainRecord(raw)) continue;
    if (typeof raw.id !== 'string' || typeof raw.action !== 'string') continue;
    jobs.push({
      id: raw.id,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      action: raw.action as StrmJobAction,
      payload: isPlainRecord(raw.payload) ? raw.payload : {},
    });
  }
  return jobs;
}

/** 查找同类待处理任务（用于 sync 防重复入队） */
export async function findPendingJob(action: StrmJobAction): Promise<StrmJob | null> {
  const jobs = await readQueueJobs();
  return jobs.find((job) => job.action === action) ?? null;
}

/**
 * 原子写入一个队列任务：文件名 job-<epochMs>-<6位随机>.json，
 * 先写 .tmp 再 rename，引擎 2s 轮询不会读到半截文件。
 */
export async function enqueueStrmJob(
  action: StrmJobAction,
  payload: Record<string, unknown>
): Promise<StrmJob> {
  const { queue } = getDataPaths();
  await fs.mkdir(queue, { recursive: true });
  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = makeJobId(Date.now(), () => crypto.randomBytes(4).toString('hex'));
    const file = path.join(queue, `${id}.json`);
    // 撞名概率极低（毫秒 + 6 位随机），命中时换一个 ID 重试而不是覆盖别人的任务
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false);
    if (exists) continue;
    const job: StrmJob = { id, createdAt, action, payload };
    await writeJsonAtomic(file, job);
    return job;
  }
  throw new Error('生成队列任务失败，请稍后重试');
}

// —— 聚合状态（/api/strm/status） ——

export async function readStrmStatus(): Promise<StrmStatusResponse> {
  const [state, indexSummary, config, log, jobs] = await Promise.all([
    readState(),
    readIndexSummary(),
    readConfigPublic(),
    readLogTail(50),
    readQueueJobs(),
  ]);
  return {
    state,
    indexSummary,
    log,
    config,
    strmRootWritable: await isStrmRootWritable(config.strmRoot),
    queuePending: jobs.length,
  };
}

/** 数据目录绝对路径（供路由日志/错误信息使用，不含机密） */
export function getDataDirForHint(): string {
  return getDataPaths().dir;
}
