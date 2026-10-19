'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const secrets = require('../fnv-secrets');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lrtv-fnv-secrets-'));
}

function makeBundleDir(files) {
  const dir = path.join(tmpDir(), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function xor169Encode(text) {
  return [...text].map((ch) => ch.charCodeAt(0) ^ 169);
}

test('内置常量与来源组合标签', () => {
  assert.equal(secrets.BUILTIN_SECRET_STRING, 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh');
  assert.equal(secrets.BUILTIN_API_KEY, '16CCEB3D-AB42-077D-36A1-F355324E4237');
  assert.equal(secrets.combineSource({ secretString: 'config', apiKey: 'config' }), 'config');
  assert.equal(secrets.combineSource({ secretString: 'builtin', apiKey: 'builtin' }), 'builtin');
  assert.equal(secrets.combineSource({ secretString: 'bundle', apiKey: 'bundle' }), 'bundle');
  assert.equal(secrets.combineSource({ secretString: 'config', apiKey: 'bundle' }), 'bundle');
});

test('listBundleFiles：只取 .js/.mjs，按体积降序', () => {
  const dir = makeBundleDir({
    'small.js': 'var a=1;',
    'large.js': 'var b=2;' + 'x'.repeat(1000),
    'ignore.css': 'body{}',
  });
  const files = secrets.listBundleFiles(dir);
  assert.deepEqual(
    files.map((file) => path.basename(file.path)),
    ['large.js', 'small.js']
  );
});

test('extractSecretFromText：secret_string 赋值优先', () => {
  const text = 'const secret_string="NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";';
  assert.equal(secrets.extractSecretFromText(text), 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh');
});

test('extractSecretFromText：无明确赋值时提取唯一的 32 位全局常量', () => {
  const text = 'var Qx="AbCdEfGh0123456789AbCdEfGh01234567", other="hello";';
  assert.equal(secrets.extractSecretFromText(text), 'AbCdEfGh0123456789AbCdEfGh01234567');
});

test('extractSecretFromText：多个候选且无上下文线索时放弃（用内置常量）', () => {
  const text =
    'var a="AbCdEfGh0123456789AbCdEfGh01234567",b="ZyXwVu9876543210ZyXwVu9876543210";';
  assert.equal(secrets.extractSecretFromText(text), '');
});

test('extractApiKeyFromText：api_key 明文赋值', () => {
  const text = 'api_key:"16CCEB3D-AB42-077D-36A1-F355324E4237"';
  assert.equal(secrets.extractApiKeyFromText(text), secrets.BUILTIN_API_KEY);
});

test('extractApiKeyFromText：字节数组 XOR 169 解码为 UUID', () => {
  const encoded = xor169Encode(secrets.BUILTIN_API_KEY);
  const text = `function vh(){return [${encoded.join(',')}]}`;
  assert.equal(secrets.extractApiKeyFromText(text), secrets.BUILTIN_API_KEY);
  assert.equal(secrets.decodeXor169(encoded), secrets.BUILTIN_API_KEY);
});

test('extractSecretsFromBundle：从 mock bundle 文件同时提取 secret 与 apiKey', () => {
  const encoded = xor169Encode(secrets.BUILTIN_API_KEY);
  const dir = makeBundleDir({
    'main.js':
      'const secret_string="NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";' +
      `function vh(){return [${encoded.join(',')}]}`,
  });
  const result = secrets.extractSecretsFromBundle(dir);
  assert.equal(result.secretString, secrets.BUILTIN_SECRET_STRING);
  assert.equal(result.apiKey, secrets.BUILTIN_API_KEY);
  assert.equal(result.scanned, 1);
  assert.equal(result.bundleFiles.length, 1);
});

test('resolveFnvSecrets：config 显式值优先，不读取 bundle', () => {
  const dir = makeBundleDir({ 'main.js': 'const secret_string="AAAA1111BBBB2222CCCC3333DDDD4444";' });
  const result = secrets.resolveFnvSecrets({
    enabled: true,
    username: 'u',
    password: 'p',
    secretString: 'config-secret-1234567890',
    apiKey: 'config-api-key-123456',
    bundleDir: dir,
  });
  assert.equal(result.secretString, 'config-secret-1234567890');
  assert.equal(result.apiKey, 'config-api-key-123456');
  assert.equal(result.source, 'config');
  assert.equal(result.configured, true);
  assert.deepEqual(result.bundleFiles, []);
});

test('resolveFnvSecrets：config 为空时从 bundle 提取', () => {
  const encoded = xor169Encode(secrets.BUILTIN_API_KEY);
  const dir = makeBundleDir({
    'main.js':
      'const secret_string="NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";' +
      `api_key:"16CCEB3D-AB42-077D-36A1-F355324E4237"` +
      `;var vh=[${encoded.join(',')}]`,
  });
  const result = secrets.resolveFnvSecrets({
    enabled: true,
    username: 'u',
    password: 'p',
    secretString: '',
    apiKey: '',
    bundleDir: dir,
  });
  assert.equal(result.secretString, secrets.BUILTIN_SECRET_STRING);
  assert.equal(result.apiKey, secrets.BUILTIN_API_KEY);
  assert.equal(result.sources.secretString, 'bundle');
  assert.equal(result.sources.apiKey, 'bundle');
  assert.equal(result.source, 'bundle');
  assert.equal(result.configured, true);
});

test('resolveFnvSecrets：bundle 不存在时回退内置常量', () => {
  const result = secrets.resolveFnvSecrets({
    enabled: true,
    username: 'u',
    password: 'p',
    secretString: '',
    apiKey: '',
    bundleDir: path.join(tmpDir(), 'missing-assets'),
  });
  assert.equal(result.secretString, secrets.BUILTIN_SECRET_STRING);
  assert.equal(result.apiKey, secrets.BUILTIN_API_KEY);
  assert.equal(result.sources.secretString, 'builtin');
  assert.equal(result.sources.apiKey, 'builtin');
  assert.equal(result.source, 'builtin');
  assert.equal(result.configured, true);
});

test('resolveFnvSecrets：缺媒体账号密码或未启用时视为未配置', () => {
  const noUser = secrets.resolveFnvSecrets({ enabled: true, username: '', password: 'p' });
  assert.equal(noUser.configured, false);
  assert.equal(noUser.source, 'none');
  assert.equal(noUser.secretString, '');
  assert.equal(noUser.apiKey, '');

  const disabled = secrets.resolveFnvSecrets({ enabled: false, username: 'u', password: 'p' });
  assert.equal(disabled.configured, false);
  assert.equal(disabled.source, 'none');
});
