#!/usr/bin/env node
'use strict';

/**
 * 引擎命令行工具（本机联调 / NAS 排障）。
 *
 *   node engine/cli.js run     --data-dir <dir> [--once]
 *   node engine/cli.js add     --data-dir <dir> --source <apiBase> --vod-id <id> [--type movie|tv] [--name ...] [--year ...]
 *   node engine/cli.js sync    --data-dir <dir>
 *   node engine/cli.js cleanup --data-dir <dir>
 *   node engine/cli.js status  --data-dir <dir>
 */

const fs = require('fs');
const path = require('path');
const { createEngine } = require('./engine-core');

function printUsage() {
  console.log(`用法:
  node engine/cli.js run     --data-dir <dir> [--once]        轮询队列（--once 只处理一轮后退出）
  node engine/cli.js add     --data-dir <dir> --source <apiBase> --vod-id <id> [--type movie|tv] [--name 名称] [--year 年份] [--source-name 源名]
  node engine/cli.js sync    --data-dir <dir>                立即增量同步 + 清理 + 刷新媒体库
  node engine/cli.js cleanup --data-dir <dir>                只清理孤儿 .strm
  node engine/cli.js status  --data-dir <dir>                打印 state.json / 索引概要
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') {
      out.once = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function makeConsoleLogger() {
  return {
    log: (message, extra) => console.log(format(message, extra)),
    info: (message, extra) => console.log(format(message, extra)),
    warn: (message, extra) => console.warn(format(message, extra)),
    error: (message, extra) => console.error(format(message, extra)),
  };
}

function format(message, extra) {
  if (extra === undefined) return String(message);
  try {
    return `${message} ${JSON.stringify(extra)}`;
  } catch {
    return `${message} ${String(extra)}`;
  }
}

function resolveDataDir(args) {
  const raw = args['data-dir'] || args.dataDir || process.env.LIBRETV_DATA_DIR || process.env.TRIM_PKGVAR;
  if (!raw || typeof raw !== 'string') {
    throw new Error('缺少 --data-dir（或设置 LIBRETV_DATA_DIR / TRIM_PKGVAR）');
  }
  return path.resolve(raw);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    printUsage();
    return 0;
  }

  const dataDir = resolveDataDir(args);
  const engine = createEngine({ dataDir, logger: makeConsoleLogger() });

  try {
    switch (command) {
      case 'run': {
        if (args.once) {
          const summary = await engine.processQueueOnce();
          printJson(summary);
          return summary.failed > 0 ? 1 : 0;
        }
        engine.start();
        console.log(`[engine] 运行中 dataDir=${dataDir}（Ctrl+C 退出）`);
        const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
        await new Promise((resolve) => {
          const shutdown = () => {
            clearInterval(keepAlive);
            resolve();
          };
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        });
        return 0;
      }
      case 'add': {
        const source = args.source || args['source-api-base'];
        const vodId = args['vod-id'] || args.vodId;
        if (!source || typeof source !== 'string') throw new Error('缺少 --source');
        if (!vodId || typeof vodId !== 'string') throw new Error('缺少 --vod-id');
        const payload = {
          sourceApiBase: source,
          vodId,
          sourceName: typeof args['source-name'] === 'string' ? args['source-name'] : '',
          vodName: typeof args.name === 'string' ? args.name : '',
          vodYear: typeof args.year === 'string' ? args.year : '',
          type: args.type === 'tv' || args.type === 'movie' ? args.type : '',
        };
        const result = await engine.handleAdd(payload);
        const refresh = await engine.flushRefresh();
        printJson({ result, refresh });
        return 0;
      }
      case 'sync': {
        const result = await engine.syncAll();
        printJson(result);
        return result.errors > 0 ? 1 : 0;
      }
      case 'cleanup': {
        const result = await engine.handleCleanup();
        const refresh = await engine.flushRefresh();
        printJson({ result, refresh });
        return 0;
      }
      case 'status': {
        const stateFile = path.join(dataDir, 'state.json');
        const indexFile = path.join(dataDir, 'strm-index.json');
        const read = (file) => {
          try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
          } catch {
            return null;
          }
        };
        const state = read(stateFile);
        const index = read(indexFile);
        printJson({
          dataDir,
          state,
          index: index
            ? {
                version: index.version,
                updatedAt: index.updatedAt,
                entryCount: Object.keys(index.entries || {}).length,
                entries: Object.keys(index.entries || {}),
              }
            : null,
          setupMarkerExists: fs.existsSync(path.join(dataDir, 'setup-needed')),
        });
        return 0;
      }
      default:
        console.error(`未知命令: ${command}`);
        printUsage();
        return 2;
    }
  } finally {
    try {
      engine.stop();
    } catch {
      /* ignore */
    }
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    })
    .catch((err) => {
      console.error(`[engine] 失败: ${(err && err.stack) || err}`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, main };
