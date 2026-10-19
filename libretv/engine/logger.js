'use strict';

/**
 * 引擎日志：
 *   - 追加写 dataDir/engine.log，格式 `ISO [level] message [extra]`
 *   - 单文件滚动：超过 2MB 时只保留末尾 1MB（丢弃截断处的半行）
 *   - 同时转发给外部 logger（start.js 传入的 console logger），转发失败不影响文件日志
 */

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./fs-util');

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;

function describeExtra(extra) {
  if (extra === undefined) return '';
  try {
    if (extra instanceof Error) {
      return ' ' + JSON.stringify({ message: extra.message, stack: extra.stack });
    }
    if (typeof extra === 'string') return ' ' + extra;
    return ' ' + JSON.stringify(extra);
  } catch {
    try {
      return ' ' + String(extra);
    } catch {
      return '';
    }
  }
}

function formatLine(level, message, extra) {
  return `${new Date().toISOString()} [${level}] ${message}${describeExtra(extra)}`;
}

function rotateIfNeeded(file, maxBytes, keepBytes) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size <= maxBytes) return;
  try {
    const keep = Math.min(keepBytes, stat.size);
    const buffer = Buffer.alloc(keep);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, keep, stat.size - keep);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString('utf8');
    // 从中间截断可能切到多字节字符/半行：丢弃第一行不完整内容
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    /* 滚动失败时继续追加，最坏情况日志文件继续变大 */
  }
}

/**
 * @param {object} options
 * @param {string} options.dataDir 数据目录
 * @param {object} [options.sink] 外部 logger（{log,info,warn,error} 任意子集）
 * @param {number} [options.maxBytes]
 * @param {number} [options.keepBytes]
 */
function createLogger(options = {}) {
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : '';
  const file = dataDir ? path.join(dataDir, 'engine.log') : '';
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BYTES;
  const keepBytes = Number.isFinite(options.keepBytes) && options.keepBytes > 0 ? options.keepBytes : KEEP_BYTES;
  const sink = options.sink && typeof options.sink === 'object' ? options.sink : null;

  function writeFileLine(line) {
    if (!file) return;
    try {
      ensureDir(dataDir);
      rotateIfNeeded(file, maxBytes, keepBytes);
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      /* 磁盘异常不能拖垮引擎 */
    }
  }

  function forward(level, message, extra) {
    if (!sink) return;
    try {
      const fn =
        (typeof sink[level] === 'function' && sink[level]) ||
        (typeof sink.log === 'function' && sink.log) ||
        null;
      if (fn) fn(message, extra);
    } catch {
      /* 外部 logger 异常忽略 */
    }
  }

  function emit(level, message, extra) {
    const text = message === undefined || message === null ? '' : String(message);
    writeFileLine(formatLine(level, text, extra));
    forward(level, text, extra);
  }

  return {
    file,
    log: (message, extra) => emit('info', message, extra),
    info: (message, extra) => emit('info', message, extra),
    warn: (message, extra) => emit('warn', message, extra),
    error: (message, extra) => emit('error', message, extra),
  };
}

module.exports = { createLogger, formatLine, MAX_BYTES, KEEP_BYTES };
