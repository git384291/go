import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 상담 세션 토큰(PM 11/21: 상담 이벤트 조작·중복 집계 방지).
 * 서버만 발급하는 서명 토큰 '<세션 id>.<만료 epoch 초>.<hex 서명>'. 브라우저가 만든 값은 믿지 않는다.
 * - 세션 id(무작위 32자 hex)가 상담 시작 건수의 키라서, 같은 세션은 몇 번을 보내도 DB가 1건만 센다.
 * - 서명이 틀리거나 만료되면 무효. 새 세션 발급은 IP별 횟수 제한(핸들러)을 받는다.
 * - 서명 키는 서버 환경변수 CONSULT_SESSION_KEY(base64, 32바이트 이상)에서만 읽는다. 없으면 상담 경로는 열리지 않는다.
 */
export const SESSION_TTL_SECONDS = 24 * 3600;

export function sessionKeyFromEnv(env: Readonly<Record<string, string | undefined>>): Buffer | null {
  const raw = env.CONSULT_SESSION_KEY;
  if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length >= 32 ? key : null;
}

const sign = (key: Buffer, id: string, exp: number) => createHmac('sha256', key).update(`consult|${id}|${exp}`, 'utf8').digest('hex');

export function issueSession(key: Buffer, nowSeconds: number = Math.floor(Date.now() / 1000)): { id: string; token: string } {
  const id = randomBytes(16).toString('hex');
  const exp = nowSeconds + SESSION_TTL_SECONDS;
  return { id, token: `${id}.${exp}.${sign(key, id, exp)}` };
}

/** 유효하면 세션 id, 아니면 null(형식·서명·만료) */
export function verifySession(key: Buffer, token: unknown, nowSeconds: number = Math.floor(Date.now() / 1000)): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = /^([0-9a-f]{32})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const exp = Number(m[2]);
  if (!Number.isSafeInteger(exp) || exp < nowSeconds) return null;
  const want = Buffer.from(sign(key, m[1], exp), 'hex');
  const got = Buffer.from(m[3], 'hex');
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
