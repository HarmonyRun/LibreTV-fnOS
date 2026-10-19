'use strict';

/**
 * 引擎入口（契约第 2/6 节）。
 *
 * startEngine({dataDir, logger}) → { stop(), getEngine() }
 *   - 与 Next standalone 同进程运行；内部定时器全部 unref()，不阻止进程退出
 *   - 重复调用返回同一个 handle（防止重复启动）
 *   - 任何启动异常都被捕获并降级为空 handle，绝不阻塞 Web 服务
 */

const path = require('path');
const { createEngine, QUEUE_POLL_MS } = require('./engine-core');

let active = null;

function resolveDefaultDataDir() {
  return (
    process.env.LIBRETV_DATA_DIR ||
    process.env.TRIM_PKGVAR ||
    path.join(process.cwd(), 'var')
  );
}

function logStartupError(logger, err) {
  const message = `STRM 引擎启动失败（Web 继续运行）: ${(err && err.stack) || err}`;
  try {
    if (logger && typeof logger.error === 'function') logger.error(message);
    else console.error(message);
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.dataDir] 数据目录，默认 LIBRETV_DATA_DIR / TRIM_PKGVAR / cwd/var
 * @param {object} [options.logger] 外部 logger（start.js 传入）
 * @returns {{stop: Function, getEngine: Function}}
 */
function startEngine(options = {}) {
  try {
    if (active) {
      try {
        if (active.engine && active.engine.logger) {
          active.engine.logger.warn('STRM 引擎已在运行，忽略重复启动');
        }
      } catch {
        /* ignore */
      }
      return active.handle;
    }
    const dataDir = options.dataDir || resolveDefaultDataDir();
    const engine = createEngine({ ...options, dataDir });
    engine.start();

    let stopped = false;
    const handle = {
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          engine.stop();
        } catch (err) {
          try {
            console.error(`[engine] 停止引擎失败: ${(err && err.message) || err}`);
          } catch {
            /* ignore */
          }
        } finally {
          if (active && active.handle === handle) active = null;
        }
      },
      getEngine() {
        return engine;
      },
    };
    active = { engine, handle };
    return handle;
  } catch (err) {
    logStartupError(options.logger, err);
    return {
      stop() {},
      getEngine() {
        return null;
      },
    };
  }
}

/** 仅用于单测：查询当前是否已有活动引擎 */
function getActiveEngine() {
  return active ? active.engine : null;
}

module.exports = {
  createEngine,
  startEngine,
  // 契约第 2 节写作 require('./engine').start(...)，保留别名兼容
  start: startEngine,
  getActiveEngine,
  QUEUE_POLL_MS,
};
