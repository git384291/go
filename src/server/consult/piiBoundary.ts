/**
 * AI 전송 경계 검사(P0 개인정보 마스킹 우회 추가검증). 고객 접수 검증(leads/intake)과 역할이 다르다:
 * - 접수 검증: 이름·전화 '양식 값'을 검증·암호화해 DB에 저장한다(AI로 가지 않는다).
 * - 이 모듈: AI로 나가는 '자유 글'을 검사한다. 데이터 최소화 원칙 — 개인정보 신호가 하나라도 있으면
 *   고객 글은 가린 형태로도 보내지 않는다(전송 0자, 승인 안내문으로 답함). 신호가 없을 때만 정규화한 글을 보낸다.
 * - 처리 순서: 정규화(NFKC·서식 문자 제거) → 허용 문자 → 이스케이프·인코딩 차단(풀지 않음) → 탐지(독립 규칙 + 기존 maskPii) → 판정.
 * - 오탐 완화: 금액(쉼표 단위·'원'), 202x~203x 날짜, 상품명 같은 영숫자 토큰, '번호이동'은 탐지용 사본에서만 제외한다.
 * - 결과·오류에는 코드만 담는다. 원문·일부 글자를 오류 메시지·로그로 내보내지 않는다.
 * 한계: 규칙 기반이다. 단서 없는 자유 형식 이름·주소, 단어로 길게 쪼갠 번호, 말로 풀어 쓴 정보는 다 잡지 못한다(잔여 위험).
 */
import { maskPii } from './piiMask';
import type { ModelInput } from './chatModel';

export type BoundaryCode = 'PII_INPUT_INVALID' | 'PII_UNSUPPORTED_CHARS' | 'PII_ENCODED_CONTENT' | 'PII_MASK_FAILED' | 'PII_DETECTED';
export type Prepared = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: BoundaryCode };

const KOR_NUM = '공영일이삼사오육칠팔구';

/** NFKC(전각·수학 숫자 → ASCII), 보이지 않는 서식 문자(Zero-width·방향 제어 등 \p{Cf}) 제거, 공백·줄바꿈을 한 칸으로 */
export function canonicalize(raw: string): string {
  return raw.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
}

/** 허용 문자: 한글, ASCII 출력 문자, 공백, 몇 가지 문장부호. 그 밖(아랍·데바나가리 숫자, 결합 문자, 기타 문자)은 막는다 */
const ALLOWED = /^[\p{Script=Hangul} -~·…“”‘’「」、。₩]*$/u;
const ESCAPES = /%[0-9A-Fa-f]{2}|\\(?:u[0-9A-Fa-f]{2,}|x[0-9A-Fa-f]{2})|&#x?[0-9A-Fa-f]+;?/;

type Run = { start: number; end: number; digits: string };
/**
 * 숫자 묶음 찾기. 숫자 사이에 maxSep 글자 이하의 구분 문자가 있으면 한 묶음으로 본다.
 * letters=false면 구분 문자는 글자·숫자가 아닌 것만, true면 글자도 허용. korean=true면 한글 숫자(공·일·이…)도 숫자로 센다.
 */
function numericRuns(t: string, maxSep: number, letters: boolean, korean: boolean): Run[] {
  const chars = Array.from(t);
  const isDigit = (c: string) => /[0-9]/.test(c) || (korean && KOR_NUM.includes(c));
  const isSep = (c: string) => (letters ? !isDigit(c) : !/[\p{L}\p{N}]/u.test(c));
  const offs: number[] = [];
  let off = 0;
  for (const c of chars) { offs.push(off); off += c.length; }
  offs.push(off);
  const runs: Run[] = [];
  let i = 0;
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

/**
 * 탐지용 사본: 개인정보가 아닌 숫자 표현을 같은 길이의 'ㅁ'으로 덮는다(숫자 묶음을 끊음). 보내는 글은 바꾸지 않는다.
 * - 금액: 0으로 시작하지 않는 쉼표 단위 7자리 이하(예: 33,000원·1,000,000), 또는 0으로 시작하지 않는 7자리 이하 + 원/만원
 * - 날짜: 2020~2039년(설치 희망일 등). 1900~2019년은 생년월일 가능성이 있어 덮지 않는다
 * - 통신 용어: 번호이동
 */
const EXEMPT: readonly RegExp[] = [
  /(?<![0-9,])[1-9]\d{0,2}(?:,\d{3}){1,2}(?![0-9]|,\d)(?:\s*원)?/g,
  /(?<![0-9])[1-9]\d{0,6}\s*(?:만\s*)?원/g,
  /(?<![0-9])20[23]\d\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?(?![0-9])/g,
  /번호\s*이동/g,
];
function detectionCopy(t: string): string {
  let s = t;
  for (const re of EXEMPT) s = s.replace(re, (m) => 'ㅁ'.repeat(m.length));
  return s;
}

/** Base64·16진 모양 토큰(풀지 않는다). 상품명(giga1000mbps·GiGA·500M)처럼 단어 모양인 것은 제외 */
function encodedToken(w: string): boolean {
  if (w.length < 8) return false;
  if (/={1,2}$/.test(w)) return true;
  const upper = /[A-Z]/.test(w), lower = /[a-z]/.test(w), digit = /[0-9]/.test(w);
  if (w.length >= 16 && /^[0-9a-fA-F]+$/.test(w) && digit && /[a-fA-F]/.test(w)) return true;
  if (/[+/]/.test(w) && w.length >= 16 && upper && lower) return true;
  const segs = w.split(/(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])|[+/_-]/).filter(Boolean);
  const caseFlips = Math.max(0, ...segs.map((s) => { let n = 0; for (let i = 1; i < s.length; i++) if (/[a-z]/.test(s[i - 1]!) !== /[a-z]/.test(s[i]!) && /[A-Za-z]/.test(s[i]!) && /[A-Za-z]/.test(s[i - 1]!)) n++; return n; }));
  if (w.length >= 12 && upper && lower && caseFlips >= 3) return true; // 무작위 대소문자 섞임(Base64)
  if (w.length >= 12 && segs.length >= 5) return true; // 숫자·글자가 자주 바뀜(Base64)
  if (w.length >= 20 && (digit || (upper && lower))) return true; // 상담 글에 쓰이지 않는 긴 토큰
  return false;
}
function hasEncoded(t: string): boolean {
  if (ESCAPES.test(t)) return true;
  for (const m of t.matchAll(/[A-Za-z0-9+/=_-]{8,}/g)) if (encodedToken(m[0])) return true;
  return false;
}

// ── 문맥 신호(이름·주소). 값 자체는 정규식으로 다 못 잡으므로, '값을 밝히는 문맥'이 보이면 전송하지 않는다 ──
const SURNAME = '김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경사부';
const NAME_STOP = new Set(['인터넷', '서비스', '전화기', '이용자', '가입자', '신청자', '명의자', '사용자', '노트북', '기본형', '고급형', '이번달', '유선망', '공유기', '셋톱박', '와이파', '기가급', '최고급', '최저가', '정상가', '조건부', '장기간', '한달간', '신규가', '오늘은', '이사철', '방문일']);
const NAME_AFTER = /^\s*(?:입니다|이에요|이예요|예요|이고요?|인데요?|이라고|라고|씨|님|고객|본인|명의)/;
const CONTEXT: readonly RegExp[] = [
  /(?:이름|성함|고객명|가입자명|예금주)\s*(?:은|는|이|가|:|=)?\s*[가-힣]{2,4}/,
  /명의자?\s*(?:는|은|:|=)\s*[가-힣]{2,4}/,
  /(?:주소|설치\s*주소|사는\s*곳|거주지?|집)\s*(?:는|은|가|:|=)\s*\S/,
  /[가-힣0-9]+(?:로|길)\s*\d+/,
  /[가-힣]+(?:동|읍|면|리)\s*\d+(?!\s*(?:개월|개|년|km|m|분|시간|대|회|번째|살|M|G|기가|메가|층|원|%))/,
  /\d+\s*동\s*\d+\s*호|\d+\s*호\s*(?:에|로|입니다|이에요)/,
  /[가-힣A-Za-z0-9]+\s*(?:아파트|빌라|오피스텔|맨션)/,
  /(?:19\d{2}|20[01]\d)\s*[년./-]\s*\d{1,2}\s*[월./-]\s*\d{1,2}/,
  /\d{2,4}\s*년\s*생|생년월일|주민\s*(?:등록)?\s*번호\s*(?:는|은|:)/,
  /계좌\s*(?:번호)?\s*(?:는|은|:)|카드\s*번호\s*(?:는|은|:)/,
];
function nameLike(t: string): boolean {
  const re = new RegExp(`(?:^|[\\s.,!?~()"'])([${SURNAME}][가-힣]{2})(?=\\s*(?:입니다|이에요|이예요|예요|이고|인데|이라고|라고|씨|님|고객|본인|명의))`, 'g');
  for (const m of t.matchAll(re)) {
    const w = m[1]!;
    if (NAME_STOP.has(w)) continue;
    if (NAME_AFTER.test(t.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

/** 고객 글 탐지(정규화된 글 기준). 발견 종류 코드만 돌려준다 */
export function strictFindings(text: string): string[] {
  const t = canonicalize(text);
  const f: string[] = [];
  if (!ALLOWED.test(t)) f.push('CHARS');
  if (/[[\]]/.test(t)) f.push('BRACKET');
  if (hasEncoded(t)) f.push('ENCODED');
  const d = detectionCopy(t);
  if (numericRuns(d, 3, false, false).some((r) => r.digits.length >= 6)) f.push('DIGITS');
  if (numericRuns(d, 2, true, false).some((r) => r.digits.length >= 9)) f.push('DIGITS_SPLIT');
  if (/01[016789]\d{7,8}/.test(d.replace(/[^0-9]/g, ''))) f.push('PHONE_SKELETON'); // 글자 사이사이에 흩어 쓴 휴대폰 번호
  if (numericRuns(d, 3, false, true).some((r) => r.digits.length >= 7 && /[^0-9]/.test(r.digits))) f.push('KOR_DIGITS');
  if (/@|\(at\)|\[at\]|골뱅이|\bat\s+[a-z0-9-]+\s+(?:dot|닷)\b/i.test(t)) f.push('EMAIL');
  if (CONTEXT.some((re) => re.test(d))) f.push('CONTEXT');
  if (nameLike(d)) f.push('NAME');
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

/**
 * 고객 글 → AI에 보낼 글(최소화). 개인정보 신호가 하나라도 있거나 어느 단계든 실패·예외면 코드만 돌려준다(전송 0자).
 * mask는 두 번째 독립 탐지기로 쓴다(기존 maskPii): 전화·이메일·주민번호·번호 표시가 생기면 차단. 이름 표시는 '저는' 오탐이 있어 자체 규칙으로 판단한다.
 */
export function prepareUserText(raw: unknown, mask: (t: string) => string = maskPii): Prepared {
  try {
    if (typeof raw !== 'string') return { ok: false, code: 'PII_INPUT_INVALID' };
    const c = canonicalize(raw);
    if (c.length < 1) return { ok: false, code: 'PII_INPUT_INVALID' };
    if (!ALLOWED.test(c)) return { ok: false, code: 'PII_UNSUPPORTED_CHARS' };
    if (hasEncoded(c)) return { ok: false, code: 'PII_ENCODED_CONTENT' };
    // 구역 표시 위조 방지: 고객이 쓴 대괄호는 소괄호로 바꾼다(모델 입력의 [승인 안내문]·[시스템] 흉내 차단)
    const out = c.replace(/\[/g, '(').replace(/\]/g, ')');
    const masked = mask(detectionCopy(out));
    if (typeof masked !== 'string') return { ok: false, code: 'PII_MASK_FAILED' };
    if (/\[(?:전화|이메일|주민번호|주소|번호)\]/.test(masked)) return { ok: false, code: 'PII_DETECTED' };
    if (strictFindings(out).length > 0) return { ok: false, code: 'PII_DETECTED' };
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
