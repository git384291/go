import 'server-only';
import type { BodyTransport } from '@/server/advertising/boundedHttp';

// 상담 AI 무료 등급 시험용 전송(PM 11/26 Gemini 전환 승인). Gemini 쪽에서는 이 파일만 fetch를 쓴다.
// - 허용 주소: Google Generative Language API의 generateContent 한 형태(https, 모델 ID 검사)만. 그 밖은 보내지 않고 오류(= 전송 안 됨 → 예약 취소).
// - 리다이렉트 금지, 캐시 금지. 재시도·로그 없음(재시도는 modelRecovery 하드 상한, 시간·바이트 상한은 boundedHttp).
// - 키는 호출부가 헤더(x-goog-api-key)로만 넘긴다. 주소(쿼리)에 키를 넣지 않는다. 이 파일은 키·본문·응답을 기록하지 않는다.
// - 무료 등급은 입력이 제품 개선에 쓰일 수 있다 → 가짜 상담 데이터 전용. 운영(production)에서는 어댑터가 모델을 만들지 않는다(geminiChatModel).
const HOST = 'generativelanguage.googleapis.com';
export const GEMINI_MODEL_ID = /^gemini-[a-z0-9][a-z0-9.-]{1,40}$/;
const ALLOWED = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([a-z0-9.-]{1,48}):generateContent$/;

/** 모델 ID → 요청 주소. 형식이 틀리면 null(주소를 지어내지 않는다) */
export function geminiEndpointFor(model: string): string | null {
  return typeof model === 'string' && GEMINI_MODEL_ID.test(model) ? `https://${HOST}/v1beta/models/${model}:generateContent` : null;
}

export const geminiFetchTransport: BodyTransport = async (url, init) => {
  const m = ALLOWED.exec(url);
  if (!m || !GEMINI_MODEL_ID.test(m[1]!)) throw new Error('DESTINATION_NOT_ALLOWED');
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal: init.signal, redirect: 'error', cache: 'no-store' });
  return { status: r.status, body: r.body };
};
