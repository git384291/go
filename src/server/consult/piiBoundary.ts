/**
 * AI 전송 경계 검사(P0 개인정보 마스킹 우회 추가검증). 고객 접수 검증(leads/intake)과 역할이 다르다:
 * - 접수 검증: 이름·전화 '양식 값'을 검증·암호화해 DB에 저장한다(AI로 가지 않는다).
 * - 이 모듈: AI로 나가는 '자유 글'을 정규화 → 허용 문자 검사 → 마스킹 → 인코딩 검사 → 독립 재검사 순으로 거르고,
 *   하나라도 통과하지 못하면 전송하지 않는다(Fail-Closed). 인코딩은 풀지 않고(복원 금지) 막는다.
 * - 결과·오류에는 코드만 담는다. 원문·일부 글자를 오류 메시지·로그로 내보내지 않는다.
 * 한계: 정규식·규칙 기반이라 자유 형식 이름·주소, 긴 단어로 쪼갠 번호 등은 다 잡지 못한다(잔여 위험으로 보고).
 */
import { maskPii } from './piiMask';
import type { ModelInput } from './chatModel';

export type BoundaryCode =
  | 'PII_INPUT_INVALID'
  | 'PII_UNSUPPORTED_CHARS'
  | 'PII_ENCODED_CONTENT'
  | 'PII_MASK_FAILED'
  | 'PII_IN_PAYLOAD';
export type Prepared = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: BoundaryCode };

/** 마스킹이 넣는 표시. 사용자 글에 남아도 되는 대괄호는 이것뿐이다 */
const TOKENS = ['[전화]', '[이메일]', '[주민번호]', '[이름]', '[주소]', '[번호]', '[생년월일]'] as const;
const TOKEN_RE = /\[(전화|이메일|주민번호|이름|주소|번호|생년월일)\]/g;
const KOR_NUM = '공영일이삼사오육칠팔구';

/** NFKC(전각·수학 숫자 → ASCII), 보이지 않는 서식 문자(Zero-width·방향 제어 등 \p{Cf}) 제거, 공백·줄바꿈을 한 칸으로 */
export function canonicalize(raw: string): string {
  return raw.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
}

/** 허용 문자: 한글, ASCII 출력 문자, 공백, 몇 가지 문장부호. 그 밖(아랍·데바나가리 숫자, 결합 문자, 기타 문자)은 막는다 */
const ALLOWED = /^[\p{Script=Hangul} -~·…“”‘’「」、。₩]*$/u;

type Run = { start: number; end: number; digits: string };
/**
 * 숫자 묶음 찾기. 숫자 사이에 maxSep 글자 이하의 구분 문자가 있으면 한 묶음으로 본다.
 * letters=false면 구분 문자는 글자·숫자가 아닌 것만, true면 글자도 허용(ASCII 숫자만 숫자로 본다).
 */
function numericRuns(t: string, maxSep: number, letters: boolean, korean: boolean): Run[] {
  const chars = Array.from(t);
  const isDigit = (c: string) => /[0-9]/.test(c) || (korean && KOR_NUM.includes(c));
  const isSep = (c: string) => (letters ? !isDigit(c) : !/[\p{L}\p{N}]/u.test(c));
  const runs: Run[] = [];
  let i = 0;
  let off = 0;
  const offs: number[] = [];
  for (const c of chars) { offs.push(off); off += c.length; }
  offs.push(off);
  while (i < chars.length) {
    if (!isDigit(chars[i]!)) { i++; continue; }
    const start = i;
    let digits = '';
    let end = i;
    let j = i;
    while (j < chars.length) {
      if (isDigit(chars[j]!)) { digits += chars[j]; end = j + 1; j++; continue; }
      let k = j;
      while (k < chars.length && k - j < maxSep && isSep(chars[k]!) && !isDigit(chars[k]!)) k++;
      if (k < chars.length && k > j && isDigit(chars[k]!)) { j = k; continue; }
      break;
    }
    runs.push({ start: offs[start]!, end: offs[end]!, digits });
    i = end;
  }
  return runs;
}

const replaceRuns = (t: string, runs: Run[], pred: (r: Run) => boolean): string => {
  let out = '';
  let last = 0;
  for (const r of runs) {
    if (!pred(r)) continue;
    out += t.slice(last, r.start) + '[번호]';
    last = r.end;
  }
  return out + t.slice(last);
};

/** 기존 maskPii에 더하는 규칙(쪼갠 번호·한글 숫자·생년월일·이름 단서·동호수·이메일 변형) */
function maskExtra(t: string): string {
  let s = t;
  s = s.replace(/[\w.+-]+\s*[([]?\s*(?:at|앳|골뱅이)\s*[)\]]?\s*[\w-]+\s*[([]?\s*(?:dot|닷|점)\s*[)\]]?\s*[a-z]{2,}/giu, '[이메일]');
  s = s.replace(/(?:19\d{2}|20[01]\d)\s*[년./-]\s*\d{1,2}\s*[월./-]\s*\d{1,2}\s*일?(?:\s*생)?/gu, '[생년월일]');
  s = s.replace(/\d{2,4}\s*년\s*생/gu, '[생년월일]');
  s = s.replace(/\d{1,4}\s*동\s*\d{1,5}\s*호/gu, '[주소]');
  s = s.replace(/[가-힣A-Za-z0-9]+\s*(?:아파트|빌라|오피스텔|맨션|타운|빌딩)/gu, '[주소]');
  s = s.replace(/(고객명|가입자|명의자?|본인|이름|성함|예금주)(\s*(?:은|는|이|:)?\s*)[가-힣]{2,4}/gu, '$1$2[이름]');
  s = s.replace(/[가-힣]{2,4}(?=\s*(?:고객|님|씨)(?:입니다|이에요|예요|인데요?|이고|요)?(?:[\s.,!?]|$))/gu, '[이름]');
  // 쪼갠 숫자: 문장부호·공백(3자 이하)으로 나눈 6자리 이상, 글자(2자 이하)로 나눈 9자리 이상, 한글 숫자 7자 이상
  s = replaceRuns(s, numericRuns(s, 3, false, false), (r) => r.digits.length >= 6);
  s = replaceRuns(s, numericRuns(s, 2, true, false), (r) => r.digits.length >= 9);
  s = replaceRuns(s, numericRuns(s, 3, false, true), (r) => r.digits.length >= 7 && /[^0-9]/.test(r.digits));
  return s;
}

/** 인코딩·이스케이프 표현(풀지 않는다): %XX, \uXXXX·\xXX, &#..;, Base64·16진 모양 토큰 */
function hasEncoded(t: string): boolean {
  const s = t.replace(TOKEN_RE, ' ');
  if (/%[0-9A-Fa-f]{2}/.test(s)) return true;
  if (/\\(?:u[0-9A-Fa-f]{2,}|x[0-9A-Fa-f]{2})|&#x?[0-9A-Fa-f]+;?/.test(s)) return true;
  for (const m of s.matchAll(/[A-Za-z0-9+/=_-]{8,}/g)) {
    const w = m[0];
    if (/[=]{1,2}$/.test(w)) return true;
    if (w.length >= 12 && /[A-Za-z]/.test(w) && /[0-9]/.test(w)) return true;
    if (w.length >= 16 && /[a-z]/.test(w) && /[A-Z]/.test(w)) return true;
    if (w.length >= 16 && /^[0-9a-fA-F]+$/.test(w)) return true;
  }
  return false;
}

/** 엄격 검사(고객 글, 마스킹 후): 숫자 묶음 6자리↑·한글 숫자 묶음·@·이메일 변형·인코딩·표시 외 대괄호가 있으면 발견 */
export function strictFindings(text: string): string[] {
  const t = canonicalize(text);
  const f: string[] = [];
  if (!ALLOWED.test(t)) f.push('CHARS');
  const bare = t.replace(TOKEN_RE, ' ');
  if (/[[\]]/.test(bare)) f.push('BRACKET');
  if (numericRuns(bare, 3, false, false).some((r) => r.digits.length >= 6)) f.push('DIGITS');
  if (numericRuns(bare, 2, true, false).some((r) => r.digits.length >= 9)) f.push('DIGITS_SPLIT');
  if (numericRuns(bare, 3, false, true).some((r) => r.digits.length >= 7 && /[^0-9]/.test(r.digits))) f.push('KOR_DIGITS');
  if (/@|\(at\)|\[at\]|골뱅이/i.test(bare)) f.push('EMAIL');
  if (hasEncoded(bare)) f.push('ENCODED');
  return f;
}

/** 서버 문장·모델 응답 검사: 전화·주민번호·9자리↑ 번호·이메일·한글 숫자 번호. 날짜·금액(쉼표)은 허용 */
export function serverFindings(text: string): string[] {
  // 정책 기준 시각(YYYY-MM-DD HH:MM)은 번호가 아니다: 글자로 바꿔 숫자 묶음을 끊는다
  const t = canonicalize(text).replace(/(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?/g, ' 날짜 ');
  const f: string[] = [];
  for (const r of numericRuns(t, 3, false, false)) {
    const d = r.digits;
    if (/^(?:0|82)1[016789]\d{7,8}$/.test(d) || /^0\d{8,10}$/.test(d)) f.push('PHONE');
    else if (/^\d{6}[1-8]\d{6}$/.test(d)) f.push('RRN');
    else if (d.length >= 9 && !/^(?:19|20)\d{6}$/.test(d)) f.push('LONG_NUMBER');
  }
  if (numericRuns(t, 2, true, false).some((r) => r.digits.length >= 10 && /^0/.test(r.digits))) f.push('PHONE_SPLIT');
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(t)) f.push('EMAIL');
  if (numericRuns(t, 3, false, true).some((r) => r.digits.length >= 7 && /[^0-9]/.test(r.digits))) f.push('KOR_DIGITS');
  return f;
}

/** 고객 글 → AI에 보낼 글. 어느 단계든 실패·예외면 코드만 돌려준다(전송 금지) */
export function prepareUserText(raw: unknown, mask: (t: string) => string = maskPii): Prepared {
  try {
    if (typeof raw !== 'string') return { ok: false, code: 'PII_INPUT_INVALID' };
    const c = canonicalize(raw);
    if (c.length < 1) return { ok: false, code: 'PII_INPUT_INVALID' };
    if (!ALLOWED.test(c)) return { ok: false, code: 'PII_UNSUPPORTED_CHARS' };
    if (/%[0-9A-Fa-f]{2}|\\(?:u[0-9A-Fa-f]{2,}|x[0-9A-Fa-f]{2})|&#x?[0-9A-Fa-f]+;?/.test(c)) return { ok: false, code: 'PII_ENCODED_CONTENT' };
    // 구역 표시 위조 방지: 고객이 쓴 대괄호는 소괄호로 바꾼다(모델 입력의 [승인 안내문]·[시스템] 흉내 차단)
    const neutral = c.replace(/\[/g, '(').replace(/\]/g, ')');
    const masked = mask(neutral);
    if (typeof masked !== 'string') return { ok: false, code: 'PII_MASK_FAILED' };
    const out = maskExtra(canonicalize(masked));
    if (hasEncoded(out)) return { ok: false, code: 'PII_ENCODED_CONTENT' };
    if (strictFindings(out).length > 0) return { ok: false, code: 'PII_MASK_FAILED' };
    return { ok: true, text: out };
  } catch {
    return { ok: false, code: 'PII_MASK_FAILED' };
  }
}

/** 외부 AI 전송 직전 최종 검사(어댑터·답변 경로 공통). 통과하지 못하면 보내지 않는다 */
export function modelInputFindings(input: ModelInput): string[] {
  try {
    if (!input || typeof input.user !== 'string' || typeof input.approved !== 'string' || typeof input.system !== 'string') return ['SHAPE'];
    return [
      ...strictFindings(input.user).map((x) => `user:${x}`),
      ...serverFindings(input.approved).map((x) => `approved:${x}`),
      ...serverFindings(input.system).map((x) => `system:${x}`),
    ];
  } catch {
    return ['ERROR'];
  }
}
export const isSafeModelInput = (input: ModelInput): boolean => modelInputFindings(input).length === 0;

/** 모델 응답 재검사. 개인정보 모양이 있으면 쓰지 않는다(승인 안내문으로 대체) */
export function replyHasPii(reply: unknown): boolean {
  try {
    return typeof reply !== 'string' || serverFindings(reply).length > 0 || /@/.test(canonicalize(reply));
  } catch {
    return true;
  }
}

export const MASK_TOKENS = TOKENS;
