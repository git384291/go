import 'server-only';
import { checkPolicy } from '@/server/consult/quoteAnswer';
import { dbPolicyProvider } from '@/server/consult/publishedPolicies';

/**
 * 접수용 정책 검증 장애(B) 판정기(PM 11/24). 상담 화면과 같은 서버 설정 상품 키(고객이 보낸 값이 아님)로 판정한다.
 * - 키가 설정돼 있으면: 상담창과 같은 판정(checkPolicy) — 조회 행 형식 오류·충돌·만료/미승인 행이면 장애.
 * - 키가 없으면(일반 접수 양식만): 게시 정책 행 형식만 검사한다(정책 없음은 장애가 아니다).
 * 고객이 보낸 신청서 값으로 다른 키를 골라 우회할 수 없다.
 */
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function policyFaultFromEnv(env: Record<string, string | undefined>) {
  const supplierId = env.QUOTE_SUPPLIER_ID ?? '';
  const carrier = env.CONSULT_CHAT_CARRIER ?? '', productId = env.CONSULT_CHAT_PRODUCT ?? '', regionCode = env.CONSULT_CHAT_REGION ?? '';
  const keyed = [supplierId, carrier, productId, regionCode].every((v) => CODE.test(v));
  return async (rows: readonly unknown[], now: Date): Promise<boolean> => {
    const provider = dbPolicyProvider(async () => rows);
    if (!keyed) { try { await provider(now); return false; } catch { return true; } }
    return (await checkPolicy(provider, { supplierId, segment: 'household', carrier, productId, regionCode, confirmedBundles: { known: false } }, now)).fault;
  };
}
