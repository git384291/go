import 'server-only';
import type { BodyTransport } from './boundedHttp';

// Google Ads 전용 실제 전송(PM 11/23 B 승인). 이 파일만 fetch를 쓴다.
// - 허용 주소: oauth2.googleapis.com/token, googleads.googleapis.com 두 곳의 https만. 그 밖은 보내지 않고 오류(= 전송 안 됨).
// - 리다이렉트 금지, 캐시 금지. 재시도·로그 없음. 시간 제한·바이트 상한은 boundedHttp가 맡는다.
const ALLOWED = /^https:\/\/(oauth2\.googleapis\.com\/token|googleads\.googleapis\.com\/v\d{2}\/customers\/\d{1,20}\/[A-Za-z]+:(mutate|search))$/;

export const googleAdsFetchTransport: BodyTransport = async (url, init) => {
  if (!ALLOWED.test(url)) throw new Error('DESTINATION_NOT_ALLOWED');
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: 'error', cache: 'no-store' });
  return { status: r.status, body: r.body };
};
