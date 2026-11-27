import 'server-only';
import { adminAuthMode } from '../auth/adminAuthMode';
import { requireStaff } from '../auth/requireStaff';
import { withRole } from '../db/client';
import { dbPolicyProvider } from '../consult/publishedPolicies';
import { quotePolicy } from '../policies';
import { createPiiCrypto, piiKeysFromEnv } from '../security/piiCrypto';
import { REQUIRED_NOTICES } from '../../content/requiredNotices';
import type { PacketQuote } from '../../content/applicationForm';
import type { SqlTag } from './policyAdmin';
import type { DealerPacketDeps } from './dealerPacket';

const won = (k: { amountKrw: number; vat: 'included' | 'excluded' }) => `${k.amountKrw.toLocaleString('en-US')}원(부가세 ${k.vat === 'included' ? '포함' : '별도'})`;
const FORM = { gift_card: '상품권', cash: '현금', bill_discount: '요금 할인', none: '없음' } as const;
const NO_POLICY: PacketQuote = { kind: 'needs_review', text: '승인된 정책 안내 없음 — 총판 확인' };

// 서버 기본 의존성(route·page 공통). 월요금·설치비·상품권은 게시된 승인 정책(견적 판정 통과)만 쓰고, 지역·상품이 없거나 조회 실패·미게시면 '총판 확인'.
export function dealerPacketDeps(): DealerPacketDeps {
  return {
    env: () => process.env, mode: () => adminAuthMode(), requireStaff,
    runInTransaction: (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag)),
    decrypt: (s) => createPiiCrypto(piiKeysFromEnv()).decrypt(s),
    now: () => new Date(),
    notices: () => REQUIRED_NOTICES,
    privacyVersion: () => (process.env.PRIVACY_POLICY_VERSION ?? '').trim(),
    quoteFor: async (app) => {
      const supplierId = process.env.QUOTE_SUPPLIER_ID ?? '';
      if (!app?.carrier || !app.productId || !app.regionCode || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(supplierId)) return NO_POLICY;
      let rows: readonly unknown[];
      try { rows = await dbPolicyProvider(async () => {
        const r = await withRole('public', (tx) => tx`select api.policy_published() as p`);
        return (r as unknown as { p: unknown }[]).map((x) => x.p);
      })(new Date()); } catch { return NO_POLICY; }
      const res = quotePolicy(rows, { supplierId, segment: 'household', carrier: app.carrier, productId: app.productId, regionCode: app.regionCode, confirmedBundles: { known: false } }, new Date());
      if (res.status !== 'quote') return NO_POLICY;
      const q = res.quote;
      const b = q.benefit;
      return {
        kind: 'quote', text: q.productLabel,
        fields: {
          productLabel: q.productLabel, monthlyFee: won(q.monthlyFee), installFee: won(q.installFee),
          gift: b.form === 'none' || b.amountKrw === 0 ? '없음' : `${b.amountKrw.toLocaleString('en-US')}원 ${FORM[b.form]}`,
        },
      };
    },
  };
}
