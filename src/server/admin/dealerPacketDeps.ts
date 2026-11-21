import 'server-only';
import { adminAuthMode } from '../auth/adminAuthMode';
import { requireStaff } from '../auth/requireStaff';
import { withRole } from '../db/client';
import { answerQuote } from '../consult/quoteAnswer';
import { dbPolicyProvider } from '../consult/publishedPolicies';
import { createPiiCrypto, piiKeysFromEnv } from '../security/piiCrypto';
import type { SqlTag } from './policyAdmin';
import type { DealerPacketDeps } from './dealerPacket';

// 서버 기본 의존성(route·page에서 공통 사용). 요금 안내는 게시된 승인 정책만 쓰고, 지역·상품이 없거나 조회 실패면 '담당자 확인'.
export function dealerPacketDeps(): DealerPacketDeps {
  return {
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
    decrypt: (s) => createPiiCrypto(piiKeysFromEnv()).decrypt(s),
    now: () => new Date(),
    quoteFor: async (app) => {
      const supplierId = process.env.QUOTE_SUPPLIER_ID ?? '';
      if (!app?.carrier || !app.productId || !app.regionCode || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(supplierId)) {
        return { kind: 'needs_review', text: '승인 정책 안내 없음 — 총판 확인' };
      }
      const published = dbPolicyProvider(async () => {
        const rows = await withRole('public', (tx) => tx`select api.policy_published() as p`);
        return (rows as unknown as { p: unknown }[]).map((r) => r.p);
      });
      const a = await answerQuote(published, { supplierId, segment: 'household', carrier: app.carrier, productId: app.productId, regionCode: app.regionCode, confirmedBundles: { known: false } }, new Date());
      return { kind: a.kind, text: a.text };
    },
  };
}
