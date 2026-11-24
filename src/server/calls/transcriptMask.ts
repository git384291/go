import { maskPii } from '../consult/piiMask';

/**
 * 통화 변환문·요약 가림(PM 11/25 ②③). 상담창 가림(maskPii) + DB 검사(core.call_text_unmasked)와 같은 모양을 한 번 더 가린다.
 * DB는 가린 글에 아래 모양이 남으면 거부하므로, 서버가 같은 규칙으로 먼저 지워 둔다.
 */
const DB_RULES: readonly RegExp[] = [
  /0[0-9]{1,2}[^0-9]{0,3}[0-9]{3,4}[^0-9]{0,3}[0-9]{4}/g,
  /[0-9]{6}[^0-9]{0,3}[1-8][0-9]{6}/g,
  /[0-9]{7,}/g,
];

export function maskTranscript(text: string): string {
  let out = maskPii(text);
  for (const re of DB_RULES) out = out.replace(re, '[번호]');
  return out;
}

/** DB core.call_text_unmasked 와 같은 판정 */
export function hasUnmaskedPii(text: string): boolean {
  return DB_RULES.some((re) => new RegExp(re.source).test(text));
}
