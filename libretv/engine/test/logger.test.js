'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../logger');

test('createLogger：写 dataDir/engine.log，格式 ISO + level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-log-'));
  const logger = createLogger({ dataDir: dir });
  logger.info('hello');
  logger.warn('careful', { a: 1 });
  logger.error('boom', new Error('x'));
  const text = fs.readFileSync(path.join(dir, 'engine.log'), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] hello$/);
  assert.match(lines[1], /\[warn\] careful \{"a":1\}$/);
  assert.match(lines[2], /\[error\] boom /);
});

test('createLogger：超过 maxBytes 时截断保留末 keepBytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-log-'));
  const logger = createLogger({ dataDir: dir, maxBytes: 600, keepBytes: 300 });
  for (let i = 0; i < 50; i += 1) logger.info(`line-${String(i).padStart(3, '0')}-${'x'.repeat(30)}`);
  const file = path.join(dir, 'engine.log');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 600, '日志文件应被截断');
  assert.match(text, /line-049-/);
  // 截断后不应出现半行（第一行应是完整的 ISO 日志行）
  assert.match(text, /^\d{4}-\d{2}-\d{2}T/);
});

test('createLogger：转发给外部 logger 且外部异常不影响文件日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-log-'));
  const received = [];
  const sink = {
    info: (message, extra) => received.push(['info', message, extra]),
    warn: () => {
      throw new Error('sink broken');
    },
    error: () => {},
  };
  const logger = createLogger({ dataDir: dir, sink });
  logger.info('ok', { n: 1 });
  assert.doesNotThrow(() => logger.warn('still writes'));
  assert.deepEqual(received, [['info', 'ok', { n: 1 }]]);
  const text = fs.readFileSync(path.join(dir, 'engine.log'), 'utf8');
  assert.match(text, /\[info\] ok \{"n":1\}/);
  assert.match(text, /\[warn\] still writes/);
});
