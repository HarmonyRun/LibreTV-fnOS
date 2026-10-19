'use strict';

/**
 * 兼容 `node --test engine/test/`：部分 Node 版本会把目录参数当成入口模块加载。
 * 这里按顺序加载全部测试文件，使目录形式与 glob 形式等价。
 * （使用 `node --test engine/test/*.test.js` 时不会加载本文件。）
 */

require('./naming.test');
require('./cms.test');
require('./index-store.test');
require('./logger.test');
require('./fnv-client.test');
require('./fnv-secrets.test');
require('./engine-core.test');
