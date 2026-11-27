import 'server-only';
import { checkPolicy } from '@/server/consult/quoteAnswer';
import { dbPolicyProvider } from '@/server/consult/publishedPolicies';

/**
 * 접수용 정책 판정(PM 11/24 결정). 상담 화면과 같은 서버 설정 상품 키(고객이 보낸 값·이전 상담 결과가 아님)로 판정한다.
 * - 키 미설정 → 접수 차단(POLICY_NOT_PUBLISHED). 판정할 정책이 없으므로 안전성이 입증되지 않는다.
 * - 조회 행 형식 오류·충돌·만료/미승인/시작 전 행 → POLICY_UNVERIFIED
 * - 유효한 승인·게시 정책 없음(게시 스위치 OFF 포함, DB가 0행) → POLICY_NOT_PUBLISHED
 * - 그 밖(유효 정책 1개) → null(정책 조건 통과. 고지 등 다른 안전조건은 따로 검사)
 */
export type PolicyKey = { readonly supplierId: string; readonly carrier: string; readonly productId: string; readonly regionCode: string };
export type PolicyVerdict = null | 'POLICY_NOT_PUBLISHED' | 'POLICY_UNVERIFIED';
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function policyKeyFromEnv(env: Record<string, string | undefined>): PolicyKey | null {
  const k = { supplierId: env.QUOTE_SUPPLIER_ID ?? '', carrier: env.CONSULT_CHAT_CARRIER ?? '', productId: env.CONSULT_CHAT_PRODUCT ?? '', regionCode: env.CONSULT_CHAT_REGION ?? '' };
  return Object.values(k).every((v) => CODE.test(v)) ? k : null;
}

export async function policyVerdict(key: PolicyKey | null, rows: readonly unknown[], now: Date): Promise<PolicyVerdict> {
  if (!key) return 'POLICY_NOT_PUBLISHED';
  const c = await checkPolicy(dbPolicyProvider(async () => rows), { ...key, segment: 'household', confirmedBundles: { known: false } }, now);
  return c.fault ? 'POLICY_UNVERIFIED' : c.present ? null : 'POLICY_NOT_PUBLISHED';
}

/** 접수 경로(route.ts)가 submitLead에 넣는 정책 검사 묶음 */
export function intakePolicyFromEnv(env: Record<string, string | undefined>) {
  const key = policyKeyFromEnv(env);
  return { key, verdict: (rows: readonly unknown[], now: Date) => policyVerdict(key, rows, now) };
}
