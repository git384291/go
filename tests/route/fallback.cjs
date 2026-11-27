// 경로 시험 전용: 아래 모듈이 '설치되어 있지 않은' 환경에서만 대체 모듈로 연결한다.
// Mac·CI(npm ci 완료)에서는 실제 next/server·postgres·server-only가 쓰인다(이 파일은 아무 일도 하지 않음).
const Module = module.constructor;
const FALLBACKS = {
  'next/server': `${__dirname}/stubs/next-server.cjs`,
  'server-only': `${__dirname}/stubs/empty.cjs`,
  postgres: `${__dirname}/stubs/postgres.cjs`,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  try {
    return origResolve.call(this, request, ...rest);
  } catch (e) {
    if (Object.prototype.hasOwnProperty.call(FALLBACKS, request) && e && e.code === 'MODULE_NOT_FOUND') {
      return FALLBACKS[request];
    }
    throw e;
  }
};
