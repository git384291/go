import 'server-only';
import { answerChat } from './chatAnswer';
import type { ChatDeps } from './chatAnswer';
import { issueSession, verifySession } from './consultSession';

/**
 * POST /api/consult/chat 처리(주입형). 스위치(CONSULT_CHAT_ENABLED)·크기·형식·IP별 횟수 제한을 모델 호출 전에 모두 거른다.
 * 모든 응답은 no-store이고, 내부 오류 내용은 내보내지 않는다.
 */
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const H = { 'Cache-Control': 'private, no-store' };
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { ...H, 'Content-Type': 'application/json' } });

export type Limiter = (ip: string, now: number) => boolean;
export function createLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return (ip, now) => {
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(ip, recent); return false; }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) for (const k of hits.keys()) { hits.delete(k); break; }
    return true;
  };
}

/**
 * 같은 상담 세션(첫 메시지는 같은 IP)의 요청이 처리 중이면 새 요청을 BUSY로 막는다 — 장애·지연 중 연타·재전송이 AI를 중복 호출하거나 중복 집계되지 않게 한다.
 * 프로세스 안의 메모리 방어(인스턴스가 여럿이면 인스턴스별). 막힌 채 남지 않도록 항목은 ttl(기본 20초) 뒤 자동으로 풀린다.
 */
export type InflightGuard = { enter(key: string, nowMs: number): boolean; leave(key: string): void };
export function createInflightGuard(ttlMs = 20_000): InflightGuard {
  const m = new Map<string, number>();
  return {
    enter(key, nowMs) {
      const t = m.get(key);
      if (t !== undefined && nowMs - t < ttlMs) return false;
      m.set(key, nowMs);
      if (m.size > 5000) for (const k of m.keys()) { if (k !== key) { m.delete(k); break; } }
      return true;
    },
    leave(key) { m.delete(key); },
  };
}
const defaultInflight = createInflightGuard();

/** 상담 시작 기록(개인정보 없음). 실패해도 상담 응답에는 영향이 없다 */
export type RecordConsult = (session: string, campaign: string | null) => Promise<void>;
export type HandlerDeps = {
  enabled: boolean; chat: ChatDeps | null; limiter: Limiter; ip: string; now: () => Date; recordConsult?: RecordConsult;
  /** 서버 서명 세션(필수 — 없으면 상담 경로는 열리지 않는다)과 IP별 새 세션 발급 제한 */
  sessionKey: Buffer | null; newSessionLimiter: Limiter;
  /** 서버 측 봇 확인(PM 11/22 F1). 새 세션을 만들 때만 부른다(Turnstile). 'ok'가 아니면 세션을 주지 않는다 */
  botCheck: (token: string, ip: string) => Promise<'ok' | 'rejected' | 'unavailable'>;
  /** DB 공용 횟수 제한(PM 11/22 F1, api.consult_rate_hit). 서버 인스턴스가 여러 개여도 한 곳에서 센다. 오류는 막는다(503) */
  rateLimit: (kind: 'chat' | 'session') => Promise<boolean>;
  /** 처리 중 중복 요청 방어(없으면 프로세스 기본값) */
  inflight?: InflightGuard;
};

export async function handleChat(req: Request, d: HandlerDeps): Promise<Response> {
  if (!d.enabled) return json(503, { ok: false, code: 'DISABLED' });
  if (!d.chat || !CODE.test(d.chat.supplierId) || !d.sessionKey) return json(503, { ok: false, code: 'SERVICE_NOT_READY' });
  if (!d.limiter(d.ip, d.now().getTime())) return json(429, { ok: false, code: 'RATE_LIMITED' });
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return json(413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, code: 'INVALID_JSON' });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, code: 'INVALID_JSON' });
  const b = body as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);
  const hasCampaign = 'campaign' in b;
  const hasSession = 'session' in b;
  const hasBot = 'turnstileToken' in b;
  const hasReq = 'requestId' in b; // 0025 멱등성 키(선택, 형식 검사)
  if (hasSession && hasBot) return json(400, { ok: false, code: 'INVALID_INPUT' }); // 봇 확인 토큰은 새 세션 요청에서만
  const allowed = ['carrier', 'message', 'productId', 'regionCode', ...(hasCampaign ? ['campaign'] : []), ...(hasSession ? ['session'] : []), ...(hasBot ? ['turnstileToken'] : []), ...(hasReq ? ['requestId'] : [])].sort().join(',');
  if (Object.keys(b).sort().join(',') !== allowed || !ok(b.carrier) || !ok(b.productId) || !ok(b.regionCode) || (hasCampaign && !ok(b.campaign)) || (hasReq && (typeof b.requestId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(b.requestId)))) return json(400, { ok: false, code: 'INVALID_INPUT' });
  // 세션: 있으면 서명 검증, 없으면 새로 발급(IP별 횟수 제한). 브라우저가 만든 id는 받지 않는다
  let sessionId = '';
  let token = '';
  const nowSec = Math.floor(d.now().getTime() / 1000);
  let key: string;
  if (hasSession) {
    const id = verifySession(d.sessionKey as Buffer, b.session, nowSec);
    if (!id) return json(400, { ok: false, code: 'INVALID_SESSION' });
    sessionId = id; token = b.session as string; key = `s:${id}`;
  } else {
    key = `i:${d.ip}`;
  }
  // 처리 중인 같은 세션(첫 메시지는 같은 IP) 요청이 있으면 DB 한도·봇 확인·모델 호출 모두 하기 전에 막는다
  const guard = d.inflight ?? defaultInflight;
  if (!guard.enter(key, d.now().getTime())) return json(429, { ok: false, code: 'BUSY' });
  try {
    if (!hasSession) {
      if (!d.newSessionLimiter(d.ip, d.now().getTime())) return json(429, { ok: false, code: 'SESSION_LIMIT' });
      // 새 세션: 서버 측 봇 확인 → DB 공용 세션 한도. 둘 다 통과해야 세션을 발급한다
      const bot = await d.botCheck(typeof b.turnstileToken === 'string' ? b.turnstileToken : '', d.ip).catch(() => 'unavailable' as const);
      if (bot === 'unavailable') return json(503, { ok: false, code: 'BOT_CHECK_UNAVAILABLE' });
      if (bot !== 'ok') return json(403, { ok: false, code: 'BOT_CHECK_FAILED' });
      const sessionOk = await d.rateLimit('session').catch(() => null);
      if (sessionOk === null) return json(503, { ok: false, code: 'RATE_CHECK_UNAVAILABLE' });
      if (!sessionOk) return json(429, { ok: false, code: 'SESSION_LIMIT' });
      const s = issueSession(d.sessionKey as Buffer, nowSec);
      sessionId = s.id; token = s.token;
    }
    // 메시지마다 DB 공용 한도(IP별·전체). 모델 호출 전에 막는다
    const chatOk = await d.rateLimit('chat').catch(() => null);
    if (chatOk === null) return json(503, { ok: false, code: 'RATE_CHECK_UNAVAILABLE' });
    if (!chatOk) return json(429, { ok: false, code: 'RATE_LIMITED' });
    const r = await answerChat(d.chat, { message: b.message, carrier: b.carrier, productId: b.productId, regionCode: b.regionCode, ...(hasReq ? { requestKey: b.requestId as string } : {}) }, d.now());
    if (!r.ok) return json(400, r);
    if (d.recordConsult) { try { await d.recordConsult(sessionId, hasCampaign ? (b.campaign as string) : null); } catch { /* 집계 실패는 상담에 영향 없음 */ } }
    return json(200, { ...r, session: token });
  } finally {
    guard.leave(key);
  }
}
