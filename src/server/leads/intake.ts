import { z } from 'zod';
import { maskName, normalizeMobile, type PiiCrypto } from '../security/piiCrypto';
import { signToken, type SigningKey } from '../security/token';
import { isActiveInterest } from '../../content/catalog';

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
    consentCollection: z.literal(true, { errorMap: () => ({ message: 'CONSENT_REQUIRED' }) }),
    marketingOptIn: z.boolean().default(false),
    privacyVersion: z.string().min(1).max(40),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
    utmSource: optionalShort(100),
    utmMedium: optionalShort(100),
    utmCampaign: optionalShort(100),
  })
  .strict();

export type LeadRequest = z.infer<typeof LeadRequestSchema>;

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

export type IntakeContext = {
  crypto: PiiCrypto;
  signingKey: SigningKey;
  currentPrivacyVersion: string; // 서버 설정값. 화면이 보낸 버전과 일치해야 한다
  clientIp: string;
  nowSeconds?: number;
};

/**
 * 신뢰할 수 있는 서버에서만 실행: 입력 검증 → 동의 확인 → 정규화 → 암호화·HMAC → 전체 필드 서명.
 * DB(api.create_lead)는 서명을 다시 검증하므로, 이 함수를 거치지 않은 값은 저장되지 않는다.
 */
export function buildCreateLeadArgs(body: unknown, ctx: IntakeContext): CreateLeadArgs {
  const parsed = LeadRequestSchema.safeParse(body);
  if (!parsed.success) {
    const consentIssue = parsed.error.issues.some((i) => i.path[0] === 'consentCollection');
    throw new LeadRejected(consentIssue ? 'CONSENT_REQUIRED' : 'INVALID_INPUT');
  }
  const input = parsed.data;
  // PHASE 1: 형식상 허용 값이어도 예약 상품이면 거부(DB api.create_lead도 별도로 다시 검사)
  if (!isActiveInterest(input.interest)) throw new LeadRejected('PRODUCT_NOT_ACTIVE');
  if (input.privacyVersion !== ctx.currentPrivacyVersion) throw new LeadRejected('CONSENT_VERSION_MISMATCH');

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
  return { token, ...a };
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
 * 실제 고객정보 수집 허용 여부. REV-004에 따라 현재 빌드는 로컬 가상 DB 모드만 허용한다.
 * 'live' 등 다른 값은 모두 차단(운영 수집은 SEC-01~03 재검수 통과 후 별도 변경으로 연다).
 */
export function leadIntakeGate(env: Record<string, string | undefined>): { enabled: boolean; reason: string } {
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
