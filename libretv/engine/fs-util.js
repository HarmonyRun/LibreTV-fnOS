'use strict';

/**
 * 零依赖文件系统工具。
 * 所有 JSON 持久化都走「临时文件 + rename」的原子写，避免进程崩溃时留下半截文件。
 */

const fs = require('fs');
const path = require('path');

let tmpCounter = 0;

/** 递归创建目录（已存在不报错） */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createTempPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  tmpCounter = (tmpCounter + 1) % 1e9;
  return path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`
  );
}

/**
 * 原子写文件：同目录写 .tmp → fsync → rename。
 * rename 在同一文件系统内是原子的，读者永远只能看到旧文件或新文件。
 */
function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = createTempPath(filePath);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* 某些文件系统不支持 fsync，忽略 */
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** 原子写 JSON（格式化 + 末尾换行，便于人工排查） */
function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2) + '\n');
  return filePath;
}

/** 读取 JSON；不存在/损坏时返回 {ok:false} 而不抛异常 */
function readJsonSafe(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(text), text };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** 静默删除文件（不存在不报错） */
function removeFileQuiet(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** target 是否严格位于 root 内部（root 自身返回 false，用于保护根目录） */
function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** 读取目录下满足条件的文件名（按名称升序），目录不存在返回 [] */
function listNames(dir, predicate) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => (typeof predicate === 'function' ? predicate(name) : true))
      .sort();
  } catch {
    return [];
  }
}

module.exports = {
  ensureDir,
  atomicWriteFile,
  atomicWriteJson,
  readJsonSafe,
  removeFileQuiet,
  isInside,
  listNames,
};
