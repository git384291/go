import { clientIpFrom } from '@/server/http/clientIp';
import { createLimiter, handleChat } from '@/server/consult/chatHandler';
import { createDbAiBudget, createModel } from '@/server/consult/chatModel';
import { recoveringModelFor } from '@/server/consult/modelRecovery';
import { sessionKeyFromEnv } from '@/server/consult/consultSession';
import { dbPolicyProvider } from '@/server/consult/publishedPolicies';
import { withRole } from '@/server/db/client';
import { verifyTurnstile } from '@/server/leads/turnstile';
import { createPiiCrypto, piiKeysFromEnv } from '@/server/security/piiCrypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 기본 꺼짐(CONSULT_CHAT_ENABLED). 메모리 제한은 1차, DB 공용 제한(0024)이 최종. 모델은 무료 모의(CONSULT_AI_MODEL=mock)뿐이고, 월 사용료 한도는 DB 집계(기본 0원). 실제 API 호출 없음.
const limiter = createLimiter(10, 60_000);
const newSessionLimiter = createLimiter(5, 3_600_000); // IP당 새 상담 세션은 1시간에 5개
const budget = createDbAiBudget((fn) => withRole('ai', (tx) => fn(tx as never)));

export async function POST(req: Request) {
  const supplierId = process.env.QUOTE_SUPPLIER_ID ?? '';
  const ip = clientIpFrom((n) => req.headers.get(n));
  return handleChat(req, {
    enabled: process.env.CONSULT_CHAT_ENABLED === 'true',
    chat: {
      supplierId, model: recoveringModelFor(createModel(process.env)), budget,
      provider: dbPolicyProvider(async () => {
        const rows = await withRole('public', (tx) => tx`select api.policy_published() as p`);
        return (rows as unknown as { p: unknown }[]).map((r) => r.p);
      }),
    },
    recordConsult: async (session, campaign) => { await withRole('public', (tx) => tx`select api.consult_event_record(${session}, ${campaign})`); },
    sessionKey: sessionKeyFromEnv(process.env), newSessionLimiter,
    limiter, ip, now: () => new Date(),
    // F1: 새 세션은 서버 측 봇 확인(Turnstile), 메시지·세션은 DB 공용 한도(IP HMAC만, 원문 IP 미저장). 키·DB 오류는 막는다(503)
    botCheck: (token, from) => verifyTurnstile(token, from),
    // AI 사용자별 비용 한도 키는 핸들러가 서명 세션 ID로 만든다(aiScopeFor, PM 11/24 ③). IP는 아래 횟수 제한에만 쓴다
    rateLimit: async (kind) => {
      const h = createPiiCrypto(piiKeysFromEnv(process.env)).ipHash(ip);
      const rows = (await withRole('public', (tx) => tx`select api.consult_rate_hit(${h}, ${kind}) as ok`)) as unknown as { ok: unknown }[];
      return rows[0]?.ok === true;
    },
  });
}
