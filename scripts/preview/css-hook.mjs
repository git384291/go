// 미리보기 렌더링 전용: Next.js 없이 페이지 컴포넌트를 렌더링할 때 CSS import를 빈 모듈로 처리
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, context);
}

// PHASE 1: Next.js가 설치되어 있지 않을 때만 미리보기용 대체 모듈로 연결한다(ESM 경로)
const FALLBACKS = {
  'next/navigation': './next-navigation-stub.cjs',
  'next/link': './next-link-stub.tsx',
};
export async function resolve(specifier, context, next) {
  // 미리보기는 react-server 조건 없이 서버 컴포넌트를 정적으로 렌더링한다. 실제 server-only 패키지는 이 조건에서
  // import만으로 예외를 내므로, 미리보기에서만 빈 모듈로 바꾼다(실제 빌드·route 시험·server smoke는 원래 동작 유지).
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (e) {
    if (Object.hasOwn(FALLBACKS, specifier) && e && e.code === 'ERR_MODULE_NOT_FOUND') {
      return { url: new URL(FALLBACKS[specifier], import.meta.url).href, shortCircuit: true };
    }
    throw e;
  }
}
