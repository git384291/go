import 'server-only';
import type { ApprovedPolicyProvider } from './quoteAnswer';

/**
 * 게시된 정책 공급자(PM 11/21 1·2항). DB 함수 api.policy_published()가 돌려준 행만 견적 입력으로 쓴다.
 * - DB는 승인·유효·게시 스위치를 이미 걸러 준다. 그래도 서버가 견적 판정(quotePolicy)에서 승인 상태·확인/유효 시각·충돌 버전을 다시 검사한다.
 * - 내부 필드(수수료·원문 위치)는 DB 값을 쓰지 않고 항상 null로 채운다.
 * - 조회 실패·형식 오류는 예외로 올려 보낸다 → answerQuote가 '담당자 확인' 안내로 닫는다(fail-closed).
 */
export type FetchPublished = () => Promise<readonly unknown[]>;

export function dbPolicyProvider(fetchPublished: FetchPublished): ApprovedPolicyProvider {
  return async () => {
    const rows = await fetchPublished();
    if (!Array.isArray(rows)) throw new Error('POLICY_ROWS_INVALID');
    return rows.map((r) => {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error('POLICY_ROW_INVALID');
      return { ...(r as Record<string, unknown>), internal: { commissionKrw: null, sourceRef: null } };
    });
  };
}
