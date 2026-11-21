// 상담 신청 폼의 순수 보조 모듈(브라우저 코드로 내려간다). 서버 검증을 대신하지 않는다.
// - 고객 입력·요청 키·봇 토큰은 호출자의 메모리에서만 다룬다. 저장소·URL·로그·분석으로 보내지 않는다.
// - 서버 응답은 상태 코드와 허용 목록에 있는 오류 코드만 읽고, 화면 문구는 아래 고정 문구만 쓴다(응답 원문 반사 없음).

export type ConsultField = 'name' | 'phone' | 'consent';
export type FieldErrors = Partial<Record<ConsultField, string>>;

/** 화면에 보이는 순서. 첫 오류 초점 이동에 쓴다 */
export const FIELD_ORDER: readonly ConsultField[] = ['name', 'phone', 'consent'];

export const FIELD_MESSAGES = {
  NAME_REQUIRED: '이름을 입력해 주세요.',
  NAME_FORMAT: '이름은 한글·영문 20자 이내로 입력해 주세요.',
  PHONE_REQUIRED: '휴대폰 번호를 입력해 주세요.',
  PHONE_FORMAT: '휴대폰 번호 형식을 확인해 주세요. 예: 010-1234-5678',
  CONSENT_REQUIRED: '[필수] 개인정보 수집·이용에 동의해 주세요.',
} as const;

export type ConsultInput = {
  name: string;
  phone: string;
  interest: string;
  contactTime: string;
  consent: boolean;
  marketing: boolean;
};

const NAME_RE = /^[가-힣a-zA-Z\s]+$/u;

/** 서버(normalizeMobile)와 같은 규칙. 통과해도 서버가 다시 검사한다 */
export function normalizePhoneDigits(raw: string): string | null {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+82')) digits = '0' + digits.slice(3);
  digits = digits.replace(/\D/g, '');
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : null;
}

export function validateConsultInput(input: ConsultInput): FieldErrors {
  const errors: FieldErrors = {};
  const name = input.name.trim();
  if (!name) errors.name = FIELD_MESSAGES.NAME_REQUIRED;
  else if (Array.from(name).length > 20 || !NAME_RE.test(name)) errors.name = FIELD_MESSAGES.NAME_FORMAT;
  const phone = input.phone.trim();
  if (!phone) errors.phone = FIELD_MESSAGES.PHONE_REQUIRED;
  else if (phone.length > 20 || normalizePhoneDigits(phone) === null) errors.phone = FIELD_MESSAGES.PHONE_FORMAT;
  if (!input.consent) errors.consent = FIELD_MESSAGES.CONSENT_REQUIRED;
  return errors;
}

export function firstErrorField(errors: FieldErrors): ConsultField | null {
  return FIELD_ORDER.find((f) => errors[f] !== undefined) ?? null;
}

/**
 * 제출 내용의 비교용 표현(메모리 전용). 키 재사용 판단에만 쓴다.
 * 이름·연락 시간은 앞뒤 공백, 번호는 숫자 정규화 결과로 비교한다(서버가 저장하는 값과 같은 기준).
 */
export function submissionFingerprint(input: ConsultInput, privacyVersion: string): string {
  return JSON.stringify([
    input.name.trim(),
    normalizePhoneDigits(input.phone) ?? input.phone.trim(),
    input.interest,
    input.contactTime.trim(),
    input.consent,
    input.marketing,
    privacyVersion,
  ]);
}

/**
 * 요청 키 계약:
 * - 직전 시도와 **같은 내용**을 다시 보내면 같은 키(응답 유실·시간 초과 뒤 재시도가 서버에서 한 건으로 합쳐지게).
 * - 내용이 하나라도 바뀌면 새 키(이전 키로 다른 내용이 '접수됨'처럼 보이는 일을 막는다).
 * 키와 비교값은 이 객체의 메모리에만 있고, 화면을 새로 열면 사라진다.
 */
export class IdempotencyKeeper {
  private last: { fingerprint: string; key: string } | null = null;
  constructor(private readonly newKey: () => string) {}
  keyFor(fingerprint: string): string {
    if (this.last && this.last.fingerprint === fingerprint) return this.last.key;
    this.last = { fingerprint, key: this.newKey() };
    return this.last.key;
  }
}

export type OutcomeKind = 'accepted' | 'field' | 'input' | 'consent_version' | 'stale' | 'secure_context' | 'rate' | 'bot' | 'not_ready' | 'temporary' | 'unknown';
export type SubmitOutcome = { kind: OutcomeKind; message: string; field?: ConsultField; retryable: boolean };

export const OUTCOME_MESSAGES = {
  accepted: '신청이 접수되었습니다. 상담 가능 시간에 순서대로 연락드립니다.',
  input: '입력 내용을 확인해 주세요.',
  consent_version: '개인정보 안내가 바뀌었습니다. 페이지를 새로 고친 뒤 다시 동의해 주세요.',
  stale: '화면이 오래되었거나 고지 문구가 바뀌었습니다. 입력하신 내용은 저장되지 않았습니다. 페이지를 새로 고친 뒤 고지를 다시 확인해 주세요.',
  secure_context: '보안 연결(https)에서만 접수할 수 있습니다. 입력하신 내용은 전송·저장되지 않았습니다. 주소가 https로 시작하는지 확인하고 다시 열어 주세요.',
  rate: '신청이 잠시 많습니다. 잠시 후 다시 시도해 주세요.',
  bot: '자동 입력 방지 확인을 다시 완료한 뒤 시도해 주세요.',
  bot_pending: '자동 입력 방지 확인을 완료한 뒤 신청해 주세요.',
  not_ready: '지금은 신청을 받을 수 없습니다.',
  temporary: '일시적인 문제로 접수되지 않았습니다. 입력 내용은 그대로 있으니 다시 시도해 주세요.',
  // 응답 없음·시간 초과·해석 불가: 저장 여부를 모른다. 접수됐다/안 됐다고 단정하지 않는다
  unknown: '접수 결과를 확인하지 못했습니다. 입력 내용은 그대로 있으니 같은 내용으로 다시 시도해 주세요.',
} as const;

/** 서버가 보내는 오류 코드 허용 목록 → 분류. 목록 밖 코드는 일시 장애로 본다(원문을 보여 주지 않는다) */
const CODE_KIND: Readonly<Record<string, { kind: OutcomeKind; field?: ConsultField }>> = {
  INVALID_PHONE: { kind: 'field', field: 'phone' },
  CONSENT_REQUIRED: { kind: 'field', field: 'consent' },
  INVALID_INPUT: { kind: 'input' },
  INVALID_JSON: { kind: 'input' },
  PAYLOAD_TOO_LARGE: { kind: 'input' },
  UNSUPPORTED_MEDIA: { kind: 'input' },
  CONSENT_VERSION_MISMATCH: { kind: 'consent_version' },
  NOTICE_HASH_MISMATCH: { kind: 'stale' },
  NOTICE_VERSION_MISMATCH: { kind: 'stale' },
  NOTICE_KEYS_MISMATCH: { kind: 'stale' },
  NOTICE_CHANGED: { kind: 'stale' },
  RATE_LIMITED: { kind: 'rate' },
  BOT_SUSPECTED: { kind: 'bot' },
  BOT_CHECK_UNAVAILABLE: { kind: 'temporary' },
  PRODUCT_NOT_ACTIVE: { kind: 'not_ready' },
  SERVICE_NOT_READY: { kind: 'not_ready' },
  LEAD_INTAKE_DISABLED: { kind: 'not_ready' },
  LOCAL_MODE_NOT_ALLOWED_ON_VERCEL: { kind: 'not_ready' },
  DATABASE_URL_INVALID: { kind: 'not_ready' },
  NON_LOCAL_DATABASE: { kind: 'not_ready' },
  INTERNAL: { kind: 'unknown' }, // 서버 내부 오류: 저장 여부를 화면에서 단정하지 않는다
};

function outcome(kind: OutcomeKind, field?: ConsultField): SubmitOutcome {
  switch (kind) {
    case 'accepted':
      return { kind, message: OUTCOME_MESSAGES[kind], retryable: false };
    case 'field': {
      const f = field ?? 'phone';
      const message = f === 'consent' ? FIELD_MESSAGES.CONSENT_REQUIRED : FIELD_MESSAGES.PHONE_FORMAT;
      return { kind, field: f, message, retryable: true };
    }
    case 'temporary':
      return { kind, message: OUTCOME_MESSAGES.temporary, retryable: true };
    case 'unknown':
      return { kind, message: OUTCOME_MESSAGES.unknown, retryable: true };
    case 'rate':
      return { kind, message: OUTCOME_MESSAGES.rate, retryable: true };
    case 'bot':
      return { kind, message: OUTCOME_MESSAGES.bot, retryable: true };
    case 'input':
      return { kind, message: OUTCOME_MESSAGES.input, retryable: true };
    case 'consent_version':
      return { kind, message: OUTCOME_MESSAGES.consent_version, retryable: false };
    case 'stale':
      return { kind, message: OUTCOME_MESSAGES.stale, retryable: false };
    case 'secure_context':
      return { kind, message: OUTCOME_MESSAGES.secure_context, retryable: false };
    case 'not_ready':
      return { kind, message: OUTCOME_MESSAGES.not_ready, retryable: false };
  }
}

/** 네트워크 실패·시간 초과(응답 없음): 서버 저장 여부 미확인 */
/** 브라우저 Web Crypto(https·localhost 필요)를 쓸 수 없음: 요청을 만들지 않는다 */
export const SECURE_CONTEXT_REQUIRED: SubmitOutcome = outcome('secure_context');

export const NETWORK_FAILURE: SubmitOutcome = outcome('unknown');

/**
 * 응답을 고정 분류로 바꾼다. 202만 접수 성공이다. 새 접수·같은 연락처 재접수·변경 요청은 밖에서 구분하지 않는다(PM 11/22 P2: 연락처 존재 여부 추측 방지 — 본문이 무엇이든 같은 문구).
 * 본문은 JSON의 `code` 문자열 하나만 보고, 허용 목록에 없으면 버린다.
 */
export function classifyResponse(status: number, body: unknown): SubmitOutcome {
  if (status === 202) return outcome('accepted');
  const code = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { code?: unknown }).code : undefined;
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_KIND, code) ? CODE_KIND[code] : undefined;
  if (known) return outcome(known.kind, known.field);
  if (status === 429) return outcome('rate');
  if (status === 503) return outcome('not_ready');
  // 허용 목록 밖·해석 불가 응답: 서버가 무엇을 했는지 모르므로 미확인으로 안내한다
  return outcome('unknown');
}

/** 응답 본문을 안전하게 읽는다(비JSON·과대 본문은 무시). 원문 문자열은 돌려주지 않는다 */
export async function readResponseBody(res: Response): Promise<unknown> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const text = await res.text();
    if (text.length > 2048) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const SUBMIT_TIMEOUT_MS = 15000;

/** 접수가 끝난 결과. 이 경우 폼을 잠그고 다시 보내지 않는다 */
export const isAcceptedKind = (k: OutcomeKind): boolean => k === 'accepted';
