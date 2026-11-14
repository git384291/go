// 미리보기 렌더링 전용: Next.js 없이 페이지 컴포넌트를 렌더링할 때 CSS import를 빈 모듈로 처리
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, context);
}

// PHASE 1: next/navigation이 설치되어 있지 않을 때만 미리보기용 대체 모듈로 연결한다(ESM 경로)
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier === 'next/navigation' && e && e.code === 'ERR_MODULE_NOT_FOUND') {
      return { url: new URL('./next-navigation-stub.cjs', import.meta.url).href, format: 'commonjs', shortCircuit: true };
    }
    throw e;
  }
}
