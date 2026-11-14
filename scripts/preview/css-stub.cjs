// 미리보기 렌더링 전용: CommonJS 경로에서 CSS import를 빈 모듈로 처리
require.extensions['.css'] = (m) => { m.exports = {}; };

// PHASE 1: next/navigation이 설치되어 있지 않을 때만 미리보기용 대체 모듈로 연결한다
const Module = require('node:module');
const path = require('node:path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  try {
    return origResolve.call(this, request, ...rest);
  } catch (e) {
    if (request === 'next/navigation' && e && e.code === 'MODULE_NOT_FOUND') {
      return path.join(__dirname, 'next-navigation-stub.cjs');
    }
    throw e;
  }
};
