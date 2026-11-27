// 미리보기 렌더링 전용: Next.js가 설치되지 않은 환경에서만 쓰인다(설치된 환경에서는 실제 next/navigation 사용).
// 실제 Next.js 15의 notFound()와 같은 표식(digest)으로 404를 알린다.
const DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';
exports.notFound = () => {
  const e = new Error(DIGEST);
  e.digest = DIGEST;
  throw e;
};
