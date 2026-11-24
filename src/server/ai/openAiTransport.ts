import 'server-only';
import type { BodyTransport } from '@/server/advertising/boundedHttp';

// 상담 AI 실제 전송(PM 11/24 ④ 실제 AI 모델 API 연동). AI 쪽에서는 이 파일만 fetch를 쓴다.
// - 허용 주소: OpenAI Responses API 한 곳(https)만. 그 밖은 보내지 않고 오류(= 전송 안 됨 → 예약 취소).
// - 리다이렉트 금지, 캐시 금지. 재시도·로그 없음(재시도는 modelRecovery 하드 상한, 시간·바이트 상한은 boundedHttp).
// - 키는 호출부가 Authorization 헤더로만 넘긴다. 이 파일은 키·본문·응답을 기록하지 않는다.
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export const openAiFetchTransport: BodyTransport = async (url, init) => {
  if (url !== OPENAI_RESPONSES_URL) throw new Error('DESTINATION_NOT_ALLOWED');
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal: init.signal, redirect: 'error', cache: 'no-store' });
  return { status: r.status, body: r.body };
};
