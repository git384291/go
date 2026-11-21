import { clientIpFrom } from '@/server/http/clientIp';
import { createLimiter, handleChat } from '@/server/consult/chatHandler';
import { createDbAiBudget, createModel } from '@/server/consult/chatModel';
import { dbPolicyProvider } from '@/server/consult/publishedPolicies';
import { withRole } from '@/server/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 기본 꺼짐(CONSULT_CHAT_ENABLED). 모델은 무료 모의(CONSULT_AI_MODEL=mock)뿐이고, 월 사용료 한도는 DB 집계(기본 0원). 실제 API 호출 없음.
const limiter = createLimiter(10, 60_000);
const budget = createDbAiBudget((fn) => withRole('ai', (tx) => fn(tx as never)));

export async function POST(req: Request) {
  const supplierId = process.env.QUOTE_SUPPLIER_ID ?? '';
  return handleChat(req, {
    enabled: process.env.CONSULT_CHAT_ENABLED === 'true',
    chat: {
      supplierId, model: createModel(process.env), budget,
      provider: dbPolicyProvider(async () => {
        const rows = await withRole('public', (tx) => tx`select api.policy_published() as p`);
        return (rows as unknown as { p: unknown }[]).map((r) => r.p);
      }),
    },
    limiter, ip: clientIpFrom((n) => req.headers.get(n)), now: () => new Date(),
  });
}
