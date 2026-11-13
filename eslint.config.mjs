// ESLint CLI(flat config) — REV-005 1항. 실행: npm run lint (= eslint .)
// next@15 + eslint-config-next@15는 기존 형식 설정을 제공하므로 FlatCompat으로 불러온다.
// (Next.js 16으로 올리면 'eslint-config-next/core-web-vitals'를 직접 spread하는 형식으로 바꾼다)
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'node_modules/**', 'test-results/**', '.local-pg/**'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='unsafe'] > TemplateLiteral", message: 'tx.unsafe에 템플릿 문자열(값 끼워 넣기) 금지: 태그드 템플릿 파라미터 바인딩을 쓴다.' },
        { selector: "CallExpression[callee.property.name='unsafe'] > BinaryExpression", message: 'tx.unsafe에 문자열 연결 금지.' },
      ],
    },
  },
  {
    files: ['src/components/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/server/*', '**/server/*'], message: '화면 컴포넌트에서 서버 모듈 import 금지' }] }],
    },
  },
];
