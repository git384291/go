// 미리보기 렌더링 전용: Next.js 없이 페이지 컴포넌트를 렌더링할 때 CSS import를 빈 모듈로 처리
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, context);
}
