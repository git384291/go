import next from 'eslint-config-next';

export default [
  ...next,
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
