import 'server-only';
import { adminAuthMode } from '../auth/adminAuthMode';
import { requireStaff } from '../auth/requireStaff';
import { withRole } from '../db/client';
import type { SqlTag, TxRunner } from './leadsReadStore';

/**
 * 관리자 리드 목록 route와 화면이 함께 쓰는 서버 기본 의존성(PM 6915664371).
 * 기존 adminAuthMode·requireStaff·기본 withRole(DATABASE_URL 접속)을 그대로 쓴다. client·TLS 계약은 바꾸지 않는다.
 * 요청 내용으로 바꿀 수 없다(호출자가 이 함수를 직접 부른다).
 */
export function defaultLeadsServerDeps() {
  const runInTransaction: TxRunner = (fn) => withRole('staff', (tx) => fn(tx as unknown as SqlTag));
  return {
    env: () => process.env as Readonly<Record<string, string | undefined>>,
    mode: () => adminAuthMode(),
    requireStaff,
    runInTransaction,
  };
}
