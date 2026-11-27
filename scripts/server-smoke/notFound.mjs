// PM 7016940331: 기본 꺼짐 상담 시안 경로(H11)의 "없는 페이지" 판정. 본문 어디서든 문자열을 찾지 않고,
// RSC 스트림의 오류 행(`<16진수 행ID>:E{"digest":"..."}`)에서 digest가 정확히 일치할 때만 Next의 not-found 신호로 본다.
export const NOT_FOUND_DIGESTS = ['NEXT_HTTP_ERROR_FALLBACK;404', 'NEXT_NOT_FOUND'];

/** RSC 본문에서 오류 행의 not-found digest를 찾는다(없으면 null). 일반 콘텐츠·문자열 언급은 무시 */
export function rscNotFoundDigest(body) {
  for (const line of String(body).split('\n')) {
    const m = /^[0-9a-f]+:E(\{.*\})\s*$/.exec(line);
    if (!m) continue;
    let obj;
    try { obj = JSON.parse(m[1]); } catch { continue; }
    if (obj && typeof obj === 'object' && typeof obj.digest === 'string' && NOT_FOUND_DIGESTS.includes(obj.digest)) return obj.digest;
  }
  return null;
}

/** HTML 요청: 404 상태여야 한다 */
export const isHtmlNotFound = ({ status }) => status === 404;

/** RSC 요청: 404 상태, 또는 200 + text/x-component + 실제 스트림의 not-found 오류 행 */
export function isRscNotFound({ status, contentType, body }) {
  if (status === 404) return { ok: true, via: '404 상태' };
  // 매개변수(; charset 등) 앞의 미디어 타입만 정확히 비교한다(`text/html; note="text/x-component"` 같은 포함 일치 금지)
  const mediaType = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (status !== 200 || mediaType !== 'text/x-component') return { ok: false, via: null };
  const d = rscNotFoundDigest(body);
  return d ? { ok: true, via: d } : { ok: false, via: null };
}
