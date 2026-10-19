import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  {
    rules: {
      // 播放器与 ArtPlayer/hls.js 交互处存在少量受控的 any（第三方类型未覆盖），
      // 保留告警即可，不阻塞构建
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

export default eslintConfig;
