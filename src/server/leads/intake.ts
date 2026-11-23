import { applicationSummary, validateApplication } from '../../content/applicationForm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createPiiCrypto, maskName, normalizeMobile, piiKeysFromEnv, type PiiCrypto } from '../security/piiCrypto';
import { signingKeyFromEnv, signToken, type SigningKey } from '../security/token';
import { isActiveInterest } from '../../content/catalog';
import { noticeReadiness, REQUIRED_NOTICES, sameNoticeKeys, type NoticeConfig } from '../../content/requiredNotices';
import { cleanGclid } from '../../content/attribution';

export const INTERESTS = ['internet_tv', 'internet_phone', 'internet_only', 'cctv_security', 'other'] as const;

const optionalShort = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v.replace(/[\u0000-\u001f\u007f]/g, '') : ''));

/** 브라우저에서 들어오는 상담 신청 본문. 서버에서 다시 검증한다. */
export const LeadRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[가-힣a-zA-Z\s]+$/u, 'NAME_FORMAT'),
    phone: z.string().trim().min(10).max(20),
    interest: z.enum(INTERESTS),
    contactTime: optionalShort(50),
    // 동의 거부는 오류 위치(path)로 판별한다(buildCreateLeadArgs). Zod 4에서 errorMap 옵션이 없어져 메시지 지정은 두지 않는다
    consentCollection: z.literal(true),
    marketingOptIn: z.boolean().default(false),
    privacyVersion: z.string().min(1).max(40),
    // PM 11/21: 고객이 확인한 필수 고지의 버전과 항목 키. 확정되지 않은 문구로는 접수하지 않는다
    noticeVersion: z.string().min(1).max(40),
    noticeKeys: z.array(z.string().max(40)).max(20),
    // 고객 화면이 실제로 보여 준 문구의 항목별 sha256(본문 trim, UTF-8). 서버 상수의 해시와 같아야 접수한다(오래된 화면·변조 방지)
    noticeHashes: z.record(z.string().max(40), z.string().regex(/^[0-9a-f]{64}$/)),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
    utmSource: optionalShort(100),
    utmMedium: optionalShort(100),
    utmCampaign: optionalShort(100),
    // 0027: Google 광고 클릭 식별값(선택). 형식 밖 값은 접수를 막지 않고 버린다(아래 cleanGclid)
    gclid: z.string().max(200).optional(),
    // 총판 전달용 신청서(AI 상담 도우미 답변). 항목·민감정보 검사는 validateApplication이 한다(아래). 없어도 접수는 된다
    application: z.record(z.string(), z.unknown()).optional(),
    // PM 11/22 ② 7: 대표 직접 연락 동의(선택). 체크했을 때만 true로 온다. 대표 후속 연락 목록(api.followup_request)에 올린다
    callbackConsent: z.literal(true).optional(),
  })
  .strict();

export type LeadRequest = z.infer<typeof LeadRequestSchema>;

/** 항목별 sha256(UTF-8, 본문 trim). DB가 저장 시 계산하는 해시·화면이 계산하는 해시와 같은 방식이다 */
export function noticeHashes(cfg: { readonly items: readonly { readonly key: string; readonly body: string }[] }): Record<string, string> {
  return Object.fromEntries(cfg.items.map((n) => [n.key, createHash('sha256').update(n.body.trim(), 'utf8').digest('hex')]));
}

export class LeadRejected extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** api.create_lead 인자 순서와 동일 (토큰 제외) */
export type CreateLeadArgs = {
  token: string;
  nameEnc: string;
  nameMasked: string;
  phoneEnc: string;
  phoneHmac: string;
  phoneLast4: string;
  interest: string;
  contactTime: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  idempotencyKey: string;
  privacyVersion: string;
  consentCollection: boolean;
  marketingOptIn: boolean;
  ipHash: string;
};

/** api.lead_gclid_attach 인자(0027, 같은 트랜잭션에서 create_lead 뒤). 서버 서명 포함 */
export type GclidArgs = { token: string; idempotencyKey: string; phoneHmac: string; gclid: string };

/** api.followup_request 인자(대표 직접 연락 동의, 같은 트랜잭션). 서버 서명 포함 */
export type FollowupArgs = { token: string; idempotencyKey: string; phoneHmac: string; privacyVersion: string };

/** api.application_save 인자(같은 트랜잭션에서 create_lead 뒤에 호출). 서버 서명 포함 */
export type ApplicationArgs = {
  token: string; idempotencyKey: string; payloadEnc: string; summary: string;
  /** 같은 연락처 재접수(리드가 새로 만들어지지 않은 경우) 때만 쓰는 api.application_amend 인자. 서버 서명 포함 */
  amendment: { token: string; phoneHmac: string; contentHmac: string };
};

/**
 * 신청서 내용 키 해시: 서버 HMAC 키 + 연락처 HMAC(고객별 솔트)로 정규화한 본문을 해시한다. 원문 복원 불가, 다른 고객끼리 같은 값이어도 해시가 다르다.
 * 같은 연락처 재접수가 원본과 같은 내용인지(저장 안 함) 다른 내용인지(변경 요청 저장) 판정하는 데만 쓴다.
 */
export function applicationContentHmac(crypto: PiiCrypto, phoneHmac: string, app: Record<string, string | undefined>): string {
  const canon = JSON.stringify(Object.keys(app).filter((k) => app[k] !== undefined && app[k] !== '').sort().map((k) => [k, app[k]]));
  return crypto.phoneHmac(`application-content:${phoneHmac}:${canon}`);
}

export type IntakeContext = {
  crypto: PiiCrypto;
  signingKey: SigningKey;
  currentPrivacyVersion: string; // 서버 설정값. 화면이 보낸 버전과 일치해야 한다
  clientIp: string;
  nowSeconds?: number;
  notices?: NoticeConfig; // 기본은 content/requiredNotices의 확정 상태(현재 미확정 → 접수 거부)
  /**
   * 정책 접수 조건(PM 11/24 결정). 넣으면(운영 route.ts) 접수 트랜잭션 안에서 DB 게이트 api.policy_intake_gate(공급자·통신사·상품:
   * 정책 상태 공유 잠금 + 게시 스위치 ON + 유효 승인 정책 정확히 1개) 뒤 api.policy_published()를 다시 읽어 verdict로 판정한다.
   * 키가 없거나 판정이 null이 아니면 저장 전에 503(POLICY_NOT_PUBLISHED·POLICY_UNVERIFIED 등)으로 취소한다.
   */
  policy?: {
    key: { supplierId: string; carrier: string; productId: string } | null;
    verdict: (rows: readonly unknown[], now: Date) => Promise<string | null>;
  };
};

/**
 * 신뢰할 수 있는 서버에서만 실행: 입력 검증 → 동의 확인 → 정규화 → 암호화·HMAC → 전체 필드 서명.
 * DB(api.create_lead)는 서명을 다시 검증하므로, 이 함수를 거치지 않은 값은 저장되지 않는다.
 */
export function buildCreateLeadArgs(body: unknown, ctx: IntakeContext): CreateLeadArgs & { application?: ApplicationArgs; followup?: FollowupArgs; gclid?: GclidArgs } {
  const parsed = LeadRequestSchema.safeParse(body);
  if (!parsed.success) {
    // 구버전 화면(고지 해시를 보내지 않음)은 입력 오류가 아니라 '오래된 화면'으로 닫는다 — 화면이 새로고침을 안내한다
    if (body !== null && typeof body === 'object' && (body as { noticeHashes?: unknown }).noticeHashes === undefined && parsed.error.issues.every((i) => i.path[0] === 'noticeHashes')) throw new LeadRejected('NOTICE_HASH_MISMATCH');
    const consentIssue = parsed.error.issues.some((i) => i.path[0] === 'consentCollection');
    throw new LeadRejected(consentIssue ? 'CONSENT_REQUIRED' : 'INVALID_INPUT');
  }
  const input = parsed.data;
  // PHASE 1: 형식상 허용 값이어도 예약 상품이면 거부(DB api.create_lead도 별도로 다시 검사)
  if (!isActiveInterest(input.interest)) throw new LeadRejected('PRODUCT_NOT_ACTIVE');
  if (input.privacyVersion !== ctx.currentPrivacyVersion) throw new LeadRejected('CONSENT_VERSION_MISMATCH');
  // 필수 고지: 문구가 확정되지 않았거나 버전이 어긋나면 접수하지 않는다. 고객이 모든 항목을 확인했어야 한다
  const notices = ctx.notices ?? REQUIRED_NOTICES;
  if (!noticeReadiness(notices, ctx.currentPrivacyVersion).ready) throw new LeadRejected('NOTICE_NOT_CONFIRMED');
  if (input.noticeVersion !== notices.version) throw new LeadRejected('NOTICE_VERSION_MISMATCH');
  if (!sameNoticeKeys(notices, input.noticeKeys)) throw new LeadRejected('NOTICE_ACK_REQUIRED');
  // 고객이 본 문구의 해시 = 서버 상수 해시(= 이어서 DB 게이트가 승인 문구와 대조하는 해시). 하나라도 다르면 접수하지 않는다
  const expected = noticeHashes(notices);
  if (!Object.keys(expected).every((k) => input.noticeHashes[k] === expected[k]) || Object.keys(input.noticeHashes).length !== Object.keys(expected).length) throw new LeadRejected('NOTICE_HASH_MISMATCH');

  let phone: string;
  try {
    phone = normalizeMobile(input.phone);
  } catch {
    throw new LeadRejected('INVALID_PHONE');
  }

  const a: Omit<CreateLeadArgs, 'token'> = {
    nameEnc: ctx.crypto.encrypt(input.name),
    nameMasked: maskName(input.name),
    phoneEnc: ctx.crypto.encrypt(phone),
    phoneHmac: ctx.crypto.phoneHmac(phone),
    phoneLast4: phone.slice(-4),
    interest: input.interest,
    contactTime: input.contactTime,
    utmSource: input.utmSource,
    utmMedium: input.utmMedium,
    utmCampaign: input.utmCampaign,
    idempotencyKey: input.idempotencyKey,
    privacyVersion: input.privacyVersion,
    consentCollection: true,
    marketingOptIn: input.marketingOptIn,
    ipHash: ctx.crypto.ipHash(ctx.clientIp),
  };

  const token = signToken('lead', leadSignedFields(a), ctx.signingKey, ctx.nowSeconds);
  const followup: FollowupArgs | undefined = input.callbackConsent === true
    ? { token: signToken('lead', ['followup', input.idempotencyKey, a.phoneHmac, input.privacyVersion], ctx.signingKey, ctx.nowSeconds), idempotencyKey: input.idempotencyKey, phoneHmac: a.phoneHmac, privacyVersion: input.privacyVersion }
    : undefined;
  const g = cleanGclid(input.gclid);
  const gclid: GclidArgs | undefined = g
    ? { token: signToken('lead', ['gclid', input.idempotencyKey, a.phoneHmac, g], ctx.signingKey, ctx.nowSeconds), idempotencyKey: input.idempotencyKey, phoneHmac: a.phoneHmac, gclid: g }
    : undefined;
  const extra = { ...(followup ? { followup } : {}), ...(gclid ? { gclid } : {}) };
  if (input.application === undefined) return { token, ...a, ...extra };
  // 신청서: 형식·민감정보(주민번호·계좌·자동이체 등) 검사 → 본문은 암호화, 요약(범주형·누락 목록)만 평문. 주소·메모는 요약에 넣지 않는다
  const v = validateApplication(input.application);
  if (!v.ok) throw new LeadRejected(v.code);
  const payloadEnc = ctx.crypto.encrypt(JSON.stringify(v.value));
  const contentHmac = applicationContentHmac(ctx.crypto, a.phoneHmac, v.value as Record<string, string | undefined>);
  const summary = JSON.stringify({ ...applicationSummary(v.value), contentHmac });
  const application: ApplicationArgs = {
    token: signToken('lead', ['application', input.idempotencyKey, payloadEnc, summary], ctx.signingKey, ctx.nowSeconds),
    idempotencyKey: input.idempotencyKey, payloadEnc, summary,
    amendment: {
      token: signToken('lead', ['amendment', input.idempotencyKey, a.phoneHmac, payloadEnc, summary, contentHmac], ctx.signingKey, ctx.nowSeconds),
      phoneHmac: a.phoneHmac, contentHmac,
    },
  };
  return { token, ...a, application, ...extra };
}

/** DB의 array[...] 순서와 동일. boolean은 PostgreSQL의 text 변환('true'/'false')과 맞춘다 */
export function leadSignedFields(a: Omit<CreateLeadArgs, 'token'>): string[] {
  return [
    a.nameEnc, a.nameMasked, a.phoneEnc, a.phoneHmac, a.phoneLast4,
    a.interest, a.contactTime, a.utmSource, a.utmMedium, a.utmCampaign,
    a.idempotencyKey, a.privacyVersion,
    String(a.consentCollection), String(a.marketingOptIn), a.ipHash,
  ];
}

/**
 * 실제 고객정보 수집 허용 여부. 기본은 꺼짐.
 * - 'local': 로컬 가상 DB만(REV-004).
 * - 'live'(PM 11/22 운영 접수 Gate 최소 구현): 아래를 **모두** 만족할 때만 열린다. 하나라도 어긋나면 사유 코드로 닫는다.
 *   ① 운영 환경(VERCEL_ENV=production, 검수 환경 preview 불가) ② 필수 고지 확정 + 개인정보처리방침 버전 일치(noticeReadiness)
 *   ③ DATABASE_URL 호스트 = LEAD_INTAKE_DB_HOST(정확히 일치, 로컬 주소 불가) ④ 접수 서명 키·개인정보 암호화/HMAC 키 유효
 *   ⑤ 봇 확인(TURNSTILE_SECRET_KEY·PUBLIC_HOSTNAME) 설정. DB 쪽 차단(lead_form 스위치·고지 승인 게이트 0016)은 그대로 추가로 적용된다.
 *   지금은 필수 고지가 코드 상수에서 미확정(confirmed:false)이라 'live'도 항상 닫힌다 — 고지 확정은 별도 승인·코드 변경 사항이다.
 */
export function leadIntakeGate(env: Record<string, string | undefined>, notices: NoticeConfig = REQUIRED_NOTICES): { enabled: boolean; reason: string } {
  if (env.LEAD_INTAKE_MODE === 'live') return liveIntakeGate(env, notices);
  if (env.LEAD_INTAKE_MODE !== 'local') return { enabled: false, reason: 'LEAD_INTAKE_DISABLED' };
  if (env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview') {
    return { enabled: false, reason: 'LOCAL_MODE_NOT_ALLOWED_ON_VERCEL' };
  }
  let host = '';
  try {
    host = new URL(env.DATABASE_URL ?? '').hostname;
  } catch {
    return { enabled: false, reason: 'DATABASE_URL_INVALID' };
  }
  if (host !== 'localhost' && host !== '127.0.0.1') return { enabled: false, reason: 'NON_LOCAL_DATABASE' };
  return { enabled: true, reason: 'LOCAL_VIRTUAL_DB' };
}

function liveIntakeGate(env: Record<string, string | undefined>, notices: NoticeConfig): { enabled: boolean; reason: string } {
  const off = (reason: string) => ({ enabled: false, reason });
  if (env.VERCEL_ENV !== 'production') return off('LIVE_REQUIRES_PRODUCTION');
  const nr = noticeReadiness(notices, (env.PRIVACY_POLICY_VERSION ?? '').trim());
  if (!nr.ready) return off(nr.reason);
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch { return off('DATABASE_URL_INVALID'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return off('DATABASE_URL_INVALID');
  const host = url.hostname.toLowerCase();
  const expected = (env.LEAD_INTAKE_DB_HOST ?? '').trim().toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return off('LIVE_DB_LOCAL');
  if (expected === '' || host !== expected) return off('LIVE_DB_HOST_MISMATCH');
  try {
    signingKeyFromEnv('lead', env as NodeJS.ProcessEnv);
    const c = createPiiCrypto(piiKeysFromEnv(env as NodeJS.ProcessEnv));
    c.encrypt('gate-check'); // 현재 암호화 키 버전이 실제로 쓰이는지
  } catch { return off('LIVE_KEYS_INVALID'); }
  if ((env.TURNSTILE_SECRET_KEY ?? '').trim() === '' || (env.PUBLIC_HOSTNAME ?? '').trim() === '') return off('LIVE_BOT_CHECK_NOT_CONFIGURED');
  return { enabled: true, reason: 'LIVE' };
}
