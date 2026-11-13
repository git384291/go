import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * 개인정보 암호화(AES-256-GCM)와 검색용 HMAC. 서버에서만 실행한다.
 * 저장 형식: v{키버전}:{iv base64}:{tag base64}:{암호문 base64}
 */
export type PiiKeys = {
  encKeys: Record<string, Buffer>; // 키 버전 → 32바이트 키
  currentVersion: string;
  hmacKey: Buffer; // 32바이트 이상, 암호화 키와 별도
  ipHashKey: Buffer; // 32바이트 이상, IP 원문을 저장하지 않기 위한 별도 키
};

export class PiiCryptoError extends Error {}

export function createPiiCrypto(keys: PiiKeys) {
  for (const [v, k] of Object.entries(keys.encKeys)) {
    if (!/^\d+$/.test(v) || k.length !== 32) throw new PiiCryptoError(`invalid encryption key v${v}`);
  }
  if (!keys.encKeys[keys.currentVersion]) throw new PiiCryptoError('current key version missing');
  if (keys.hmacKey.length < 32 || keys.ipHashKey.length < 32) throw new PiiCryptoError('hmac keys must be >= 32 bytes');

  function encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', keys.encKeys[keys.currentVersion], iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v${keys.currentVersion}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  function decrypt(stored: string): string {
    const m = /^v(\d+):([^:]+):([^:]+):([^:]*)$/.exec(stored);
    if (!m) throw new PiiCryptoError('INVALID_CIPHERTEXT');
    const key = keys.encKeys[m[1]];
    if (!key) throw new PiiCryptoError(`KEY_VERSION_UNAVAILABLE:${m[1]}`);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(m[2], 'base64'));
    d.setAuthTag(Buffer.from(m[3], 'base64'));
    return Buffer.concat([d.update(Buffer.from(m[4], 'base64')), d.final()]).toString('utf8');
  }

  function phoneHmac(normalizedPhone: string): string {
    return createHmac('sha256', keys.hmacKey).update(normalizedPhone, 'utf8').digest('hex');
  }

  function ipHash(ip: string): string {
    return createHmac('sha256', keys.ipHashKey).update(ip, 'utf8').digest('hex');
  }

  return { encrypt, decrypt, phoneHmac, ipHash };
}

export type PiiCrypto = ReturnType<typeof createPiiCrypto>;

/** 010-1234-5678, 01012345678, +82 10-1234-5678 → 01012345678 */
export function normalizeMobile(raw: string): string {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+82')) digits = '0' + digits.slice(3);
  digits = digits.replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(digits)) throw new PiiCryptoError('INVALID_PHONE');
  return digits;
}

/** 홍길동 → 홍*동, 김철 → 김*, 남궁민수 → 남**수 */
export function maskName(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) throw new PiiCryptoError('INVALID_NAME');
  if (chars.length === 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return chars[0] + '*'.repeat(chars.length - 2) + chars[chars.length - 1];
}

/** 환경변수: PII_ENC_KEYS='{"1":"<base64>"}', PII_ENC_CURRENT='1', PII_HMAC_KEY, PII_IP_HASH_KEY (base64) */
export function piiKeysFromEnv(env: NodeJS.ProcessEnv = process.env): PiiKeys {
  const parsed = JSON.parse(env.PII_ENC_KEYS ?? '{}') as Record<string, string>;
  return {
    encKeys: Object.fromEntries(Object.entries(parsed).map(([v, k]) => [v, Buffer.from(k, 'base64')])),
    currentVersion: env.PII_ENC_CURRENT ?? '',
    hmacKey: Buffer.from(env.PII_HMAC_KEY ?? '', 'base64'),
    ipHashKey: Buffer.from(env.PII_IP_HASH_KEY ?? '', 'base64'),
  };
}
