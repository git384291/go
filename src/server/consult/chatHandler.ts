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

/** 상담 시작 기록(개인정보 없음). 실패해도 상담 응답에는 영향이 없다 */
export type RecordConsult = (session: string, campaign: string | null) => Promise<void>;
export type HandlerDeps = {
  enabled: boolean; chat: ChatDeps | null; limiter: Limiter; ip: string; now: () => Date; recordConsult?: RecordConsult;
  /** 서버 서명 세션(필수 — 없으면 상담 경로는 열리지 않는다)과 IP별 새 세션 발급 제한 */
  sessionKey: Buffer | null; newSessionLimiter: Limiter;
};

export async function handleChat(req: Request, d: HandlerDeps): Promise<Response> {
  if (!d.enabled) return json(503, { ok: false, code: 'DISABLED' });
  if (!d.chat || !CODE.test(d.chat.supplierId) || !d.sessionKey) return json(503, { ok: false, code: 'SERVICE_NOT_READY' });
  if (!d.limiter(d.ip, d.now().getTime())) return json(429, { ok: false, code: 'RATE_LIMITED' });
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 2048) return json(413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, code: 'INVALID_JSON' });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, code: 'INVALID_JSON' });
  const b = body as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);
  const hasCampaign = 'campaign' in b;
  const hasSession = 'session' in b;
  const allowed = ['carrier', 'message', 'productId', 'regionCode', ...(hasCampaign ? ['campaign'] : []), ...(hasSession ? ['session'] : [])].sort().join(',');
  if (Object.keys(b).sort().join(',') !== allowed || !ok(b.carrier) || !ok(b.productId) || !ok(b.regionCode) || (hasCampaign && !ok(b.campaign))) return json(400, { ok: false, code: 'INVALID_INPUT' });
  // 세션: 있으면 서명 검증, 없으면 새로 발급(IP별 횟수 제한). 브라우저가 만든 id는 받지 않는다
  let sessionId: string;
  let token: string;
  const nowSec = Math.floor(d.now().getTime() / 1000);
  if (hasSession) {
    const id = verifySession(d.sessionKey as Buffer, b.session, nowSec);
    if (!id) return json(400, { ok: false, code: 'INVALID_SESSION' });
    sessionId = id; token = b.session as string;
  } else {
    if (!d.newSessionLimiter(d.ip, d.now().getTime())) return json(429, { ok: false, code: 'SESSION_LIMIT' });
    const s = issueSession(d.sessionKey as Buffer, nowSec);
    sessionId = s.id; token = s.token;
  }
  const r = await answerChat(d.chat, { message: b.message, carrier: b.carrier, productId: b.productId, regionCode: b.regionCode }, d.now());
  if (!r.ok) return json(400, r);
  if (d.recordConsult) { try { await d.recordConsult(sessionId, hasCampaign ? (b.campaign as string) : null); } catch { /* 집계 실패는 상담에 영향 없음 */ } }
  return json(200, { ...r, session: token });
}
