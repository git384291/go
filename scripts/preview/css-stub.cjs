// 미리보기 렌더링 전용: CommonJS 경로에서 CSS import를 빈 모듈로 처리
require.extensions['.css'] = (m) => { m.exports = {}; };

// PHASE 1: Next.js가 설치되어 있지 않을 때만 미리보기용 대체 모듈로 연결한다(설치된 환경에서는 실제 모듈 사용)
// require() 호출 없이 현재 모듈의 생성자(Module)로 경로 해석 함수에 접근한다.
const Module = module.constructor;
const FALLBACKS = {
  'next/navigation': `${__dirname}/next-navigation-stub.cjs`,
  'next/link': `${__dirname}/next-link-stub.tsx`,
};
const origResolve = Module._resolveFilename;
// 미리보기는 react-server 조건 없이 서버 컴포넌트를 정적으로 렌더링한다. 실제 server-only 패키지는 이 조건에서
// import만으로 예외를 내므로, 미리보기에서만 항상 빈 모듈로 바꾼다(실제 빌드·route 시험·server smoke는 원래 동작 유지).
const SERVER_ONLY_STUB = `${__dirname}/../../tests/route/stubs/empty.cjs`;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'server-only') return SERVER_ONLY_STUB;
  try {
    return origResolve.call(this, request, ...rest);
  } catch (e) {
    if (Object.prototype.hasOwnProperty.call(FALLBACKS, request) && e && e.code === 'MODULE_NOT_FOUND') {
      return FALLBACKS[request];
    }
    throw e;
  }
};
