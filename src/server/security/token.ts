import { createHash, createHmac } from 'node:crypto';

/**
 * 서버 → DB 서명 토큰.
 * DB 함수 security.verify_token(purpose, token, fields)와 같은 규칙을 사용한다.
 *   토큰: '<key_id>.<만료 epoch 초>.<hex 서명>'
 *   서명 대상: 'fideon|<purpose>|<key_id>|<exp>|sha256(f1)|sha256(f2)|...'
 * 필드 값이 null/undefined이면 빈 문자열로 취급한다(DB의 coalesce(f, '')와 동일).
 */
export type TokenPurpose = 'staff' | 'lead';

export type SigningKey = { keyId: number; secret: Buffer };

export const TOKEN_TTL_SECONDS = 120; // DB는 최대 300초까지 허용

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function signToken(
  purpose: TokenPurpose,
  fields: ReadonlyArray<string | null | undefined>,
  key: SigningKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): string {
  if (key.secret.length < 32) throw new Error('signing key must be at least 32 bytes');
  if (!Number.isInteger(key.keyId) || key.keyId < 0) throw new Error('invalid key id');
  const exp = nowSeconds + ttlSeconds;
  const msg =
    `fideon|${purpose}|${key.keyId}|${exp}` + fields.map((f) => `|${sha256hex(f ?? '')}`).join('');
  const sig = createHmac('sha256', key.secret).update(msg, 'utf8').digest('hex');
  return `${key.keyId}.${exp}.${sig}`;
}

/** 환경변수 'FIDEON_<PURPOSE>_SIGNING_KEY' = '<key_id>:<base64 32바이트 이상>' */
export function signingKeyFromEnv(purpose: TokenPurpose, env: NodeJS.ProcessEnv = process.env): SigningKey {
  const raw = env[`FIDEON_${purpose.toUpperCase()}_SIGNING_KEY`];
  const m = raw ? /^(\d+):([A-Za-z0-9+/=]+)$/.exec(raw) : null;
  if (!m) throw new Error(`FIDEON_${purpose.toUpperCase()}_SIGNING_KEY missing or malformed`);
  const secret = Buffer.from(m[2], 'base64');
  if (secret.length < 32) throw new Error(`FIDEON_${purpose.toUpperCase()}_SIGNING_KEY must be >= 32 bytes`);
  return { keyId: Number(m[1]), secret };
}
