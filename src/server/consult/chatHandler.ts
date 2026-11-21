import 'server-only';
import { answerChat } from './chatAnswer';
import type { ChatDeps } from './chatAnswer';

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

export type HandlerDeps = { enabled: boolean; chat: ChatDeps | null; limiter: Limiter; ip: string; now: () => Date };

export async function handleChat(req: Request, d: HandlerDeps): Promise<Response> {
  if (!d.enabled) return json(503, { ok: false, code: 'DISABLED' });
  if (!d.chat || !CODE.test(d.chat.supplierId)) return json(503, { ok: false, code: 'SERVICE_NOT_READY' });
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
  const keys = Object.keys(b).sort().join(',');
  const ok = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);
  if (keys !== 'carrier,message,productId,regionCode' || !ok(b.carrier) || !ok(b.productId) || !ok(b.regionCode)) return json(400, { ok: false, code: 'INVALID_INPUT' });
  const r = await answerChat(d.chat, { message: b.message, carrier: b.carrier, productId: b.productId, regionCode: b.regionCode }, d.now());
  if (!r.ok) return json(400, r);
  return json(200, r);
}
