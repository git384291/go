import 'server-only';
// 광고 소재 AI 생성 오케스트레이터 (PM 6943345830). **생성기는 필수 주입이며 실제 연결은 없다(실모델 미호출·매체 미게재).**
//
// - 입력: 고정 상황 ID(moving / contract_end / general_compare)와 product 'internet-tv'만. 자유 문구·고객정보·요금·혜택·정책은 받지 않는다.
// - 프롬프트: 서버가 고정 일반 안내로 구성한다(입력 원문을 끼워 넣지 않는다).
// - 생성기 미설정(null)·꺼짐이면 호출 0회, NOT_CONFIGURED. 1요청당 최대 1회 호출, 재시도 없음.
// - 모델 반환은 **불신 데이터**다. 정확히 {title, description}이고 길이·문자·금지 주장 검사를 통과해야 한다.
//   실패하면 고정 오류 코드만 돌려준다. 예외·원문·키·provider 메타데이터는 내보내지 않는다.
// - 고정 초안(adDrafts)으로 대체(fallback)해 "AI 생성 성공"을 만들지 않는다. source는 'model'일 때만 성공이다.
// - 생성 결과는 미게시 초안이다. executionAllowed는 항상 false이고, 집행 조건(campaignDraft blocker 7개)을 해결하지 않는다.
// - 금지 문구 필터는 완전한 사실 검증이 아니다. 품질·사실성은 사람이 검수한다.
import { AD_DRAFT_IDS, AD_DRAFTS, AD_TITLE_MAX, AD_DESC_MIN, AD_DESC_MAX, codePointLength, type AdDraftId } from '@/content/adDrafts';

/** 생성기에 넘기는 고정 프롬프트(서버 구성) */
export type AdPrompt = { readonly instructions: string; readonly input: string };

export type GeneratorErrorCode =
  | 'NOT_CONFIGURED' | 'TIMEOUT' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'TRANSPORT_ERROR'
  | 'TOO_LARGE' | 'BAD_RESPONSE' | 'REFUSED' | 'INCOMPLETE'
  | 'BUDGET_DENIED' | 'INPUT_TOO_LARGE';  // 0026: 공통 비용 게이트 거부·입력 토큰 상한 초과(둘 다 전송 0회)

export const GENERATOR_ERROR_CODES: readonly GeneratorErrorCode[] = Object.freeze([
  'NOT_CONFIGURED', 'TIMEOUT', 'RATE_LIMITED', 'HTTP_ERROR', 'TRANSPORT_ERROR', 'TOO_LARGE', 'BAD_RESPONSE', 'REFUSED', 'INCOMPLETE', 'BUDGET_DENIED', 'INPUT_TOO_LARGE',
]);

/** 생성기 결과. data는 불신 데이터다. called는 실제 transport 호출이 일어났는지(가상 transport 포함) */
export type GeneratorOutcome =
  | { readonly kind: 'ok'; readonly data: unknown; readonly called: true }
  | { readonly kind: 'error'; readonly code: GeneratorErrorCode; readonly called: boolean };

export type AdCopyGenerator = { readonly generate: (prompt: AdPrompt) => Promise<GeneratorOutcome> };

export type AdGenerationResult =
  | {
      readonly ok: true;
      readonly source: 'model';
      readonly situationId: AdDraftId;
      readonly product: 'internet-tv';
      readonly title: string;
      readonly titleLength: number;
      readonly description: string;
      readonly descriptionLength: number;
      readonly status: 'DRAFT_UNPUBLISHED';
      readonly executionAllowed: false;
      readonly generatorCalled: true;
    }
  | {
      readonly ok: false;
      readonly error: 'INVALID_INPUT' | 'NOT_CONFIGURED' | 'GENERATION_FAILED' | 'OUTPUT_REJECTED';
      readonly reason?: GeneratorErrorCode | 'SHAPE' | 'LENGTH' | 'CHARSET' | 'FORBIDDEN';
      readonly generatorCalled: boolean;
    };

const fail = (error: Exclude<AdGenerationResult, { ok: true }>['error'], generatorCalled: boolean, reason?: Exclude<AdGenerationResult, { ok: true }>['reason']): AdGenerationResult =>
  Object.freeze(reason ? { ok: false, error, reason, generatorCalled } : { ok: false, error, generatorCalled });

// 허용 문자: 한글, 영문, 공백, 일부 문장부호. 숫자는 금액·속도·순위 주장을 막기 위해 받지 않는다.
const ALLOWED = /^[가-힣A-Za-z +·.,!?()~\-]+$/u;
// 미확인 주장·본사 오인·통신사 표지·연락 유도(소문자로 비교)
export const AD_GENERATION_BANNED = Object.freeze([
  '만원', '천원', '최저', '최대', '최고', '무료', '공짜', '당일', '즉시', '현금', '사은품', '상품권', '할인', '지원금', '페이백', '혜택 보장',
  '보장', '무조건', '100', '1위', '법정', '무중단', '끊김', '배 빠른', '후기', '리뷰', '만족', '공식', '본사', '직영', '대리점', '고객센터',
  'kt', 'sk', 'lg', 'u+', '유플러스', '올레', 'b tv', 'btv', '지니', '카톡', '카카오', '전화', '문자', '링크', 'http', 'www', '.com', '@',
] as const);

const FIXED_INSTRUCTIONS = [
  '너는 한국어 검색광고 소재 초안을 쓰는 보조 도구다.',
  '인터넷+TV 결합 상품의 가입 상담을 안내하는 광고 제목과 설명을 한 쌍 쓴다.',
  `제목은 ${AD_TITLE_MAX}자 이하, 설명은 ${AD_DESC_MIN}자 이상 ${AD_DESC_MAX}자 이하(공백 포함)로 쓴다.`,
  '숫자, 금액, 요금, 사은품, 할인, 당일·즉시, 최저·최대·최고, 보장, 공식·본사·직영, 통신사 이름, 후기, 연락처, 링크를 쓰지 않는다.',
  '설치 가능 여부와 요금·혜택은 별도 확인이 필요하다는 점을 약속 없이 표현한다.',
  '지정된 JSON 형식으로 title과 description만 출력한다.',
].join('\n');

const INPUT_ARGS_KEYS = ['situationId', 'product'];

/** 서버 고정 프롬프트. 상황 문장은 고정 초안 데이터에서만 가져온다 */
export function buildAdPrompt(situationId: AdDraftId): AdPrompt {
  return Object.freeze({ instructions: FIXED_INSTRUCTIONS, input: `고객 상황(가설): ${AD_DRAFTS[situationId].situation}` });
}

/** 모델 반환 검증. 통과하면 정확한 두 문자열만 돌려준다 */
type CopyCheck = { ok: true; title: string; description: string } | { ok: false; reason: 'SHAPE' | 'LENGTH' | 'CHARSET' | 'FORBIDDEN' };

/** 모델 반환 검증(공개). 접근자·Proxy 예외도 고정 실패(SHAPE)로 닫는다 */
export function validateAdCopy(data: unknown): CopyCheck {
  try {
    return validateAdCopyUnsafe(data);
  } catch {
    return { ok: false, reason: 'SHAPE' };
  }
}

function validateAdCopyUnsafe(data: unknown): CopyCheck {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'SHAPE' };
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'SHAPE' };
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('title') || !keys.includes('description')) return { ok: false, reason: 'SHAPE' };
  const { title, description } = data as Record<string, unknown>;
  if (typeof title !== 'string' || typeof description !== 'string') return { ok: false, reason: 'SHAPE' };
  const tl = codePointLength(title);
  const dl = codePointLength(description);
  if (tl < 1 || tl > AD_TITLE_MAX || dl < AD_DESC_MIN || dl > AD_DESC_MAX) return { ok: false, reason: 'LENGTH' };
  for (const s of [title, description]) {
    if (s !== s.trim() || /\s{2,}/.test(s) || !ALLOWED.test(s)) return { ok: false, reason: 'CHARSET' };
    const low = s.toLowerCase();
    if (AD_GENERATION_BANNED.some((b) => low.includes(b))) return { ok: false, reason: 'FORBIDDEN' };
  }
  return { ok: true, title: String(title), description: String(description) };
}

/**
 * 광고 소재 생성(미게시 초안). generator가 null이면 호출 없이 NOT_CONFIGURED.
 * 어떤 경우에도 고정 초안으로 대체하지 않고, executionAllowed는 false다.
 */
export async function generateAdCopy(input: unknown, deps: { readonly generator: AdCopyGenerator | null }): Promise<AdGenerationResult> {
  let situationId: AdDraftId;
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_INPUT', false);
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return fail('INVALID_INPUT', false);
    const keys = Object.keys(input);
    if (keys.length !== INPUT_ARGS_KEYS.length || !INPUT_ARGS_KEYS.every((k) => keys.includes(k))) return fail('INVALID_INPUT', false);
    const { situationId: sid, product } = input as Record<string, unknown>;
    if (typeof sid !== 'string' || !(AD_DRAFT_IDS as readonly string[]).includes(sid) || product !== 'internet-tv') return fail('INVALID_INPUT', false);
    situationId = sid as AdDraftId;
  } catch {
    return fail('INVALID_INPUT', false);
  }
  // deps·outcome 접근은 모두 불신 경계 안에서 한다(접근자·Proxy 예외 → 고정 실패, 원문 미반환)
  let generate: AdCopyGenerator['generate'];
  try {
    const g = deps ? deps.generator : null;
    if (g === null || g === undefined || typeof g.generate !== 'function') return fail('NOT_CONFIGURED', false);
    generate = g.generate.bind(g);
  } catch {
    return fail('NOT_CONFIGURED', false);
  }

  let raw: unknown;
  try {
    raw = await generate(buildAdPrompt(situationId));
  } catch {
    return fail('GENERATION_FAILED', true, 'TRANSPORT_ERROR');
  }
  let data: unknown;
  try {
    if (raw === null || typeof raw !== 'object') return fail('GENERATION_FAILED', true, 'BAD_RESPONSE');
    const o = raw as Record<string, unknown>;
    const kind = o.kind;
    const called = o.called;
    if (kind === 'error') {
      if (typeof called !== 'boolean') return fail('GENERATION_FAILED', true, 'BAD_RESPONSE');
      const c = o.code;
      const code: GeneratorErrorCode = (GENERATOR_ERROR_CODES as readonly unknown[]).includes(c) ? (c as GeneratorErrorCode) : 'BAD_RESPONSE';
      if (code === 'NOT_CONFIGURED' && called === false) return fail('NOT_CONFIGURED', false);
      return fail('GENERATION_FAILED', called, code);
    }
    // 성공은 called === true(boolean true)일 때만. 누락·false·문자열은 호출 증거가 아니므로 거부
    if (kind !== 'ok' || called !== true) return fail('GENERATION_FAILED', true, 'BAD_RESPONSE');
    data = o.data;
  } catch {
    return fail('GENERATION_FAILED', true, 'BAD_RESPONSE');
  }
  const v = validateAdCopy(data);
  if (!v.ok) return fail('OUTPUT_REJECTED', true, v.reason);
  return Object.freeze({
    ok: true,
    source: 'model',
    situationId,
    product: 'internet-tv',
    title: v.title,
    titleLength: codePointLength(v.title),
    description: v.description,
    descriptionLength: codePointLength(v.description),
    status: 'DRAFT_UNPUBLISHED',
    executionAllowed: false,
    generatorCalled: true,
  });
}
