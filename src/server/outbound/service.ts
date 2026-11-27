import 'server-only';
import { withRole } from '@/server/db/client';
import { createOutboundService, type AssembleOptions, type OutboundService } from './assemble';
import type { OutboundSql, OutboundTx } from './db';

/**
 * 서버 전용 광고성 전화 서비스 팩토리. 기존 트랜잭션 배선(withRole)으로 통화 작업자 역할 app_call에 고정하고, 사업자 ID를 생성 때 고정한다.
 * 공개 route·클라이언트에서 쓰지 않는다(시험 OSW-BUNDLE). 실제 발신 endpoint·스케줄러는 없다. 🔴 live 발신은 계속 금지.
 */
export const appCallTx: OutboundTx = (fn) => withRole('call', (sql) => fn(sql as unknown as OutboundSql));

export function serverOutboundService(businessId: string, env: Readonly<Record<string, string | undefined>> = process.env, extra: Omit<AssembleOptions, 'businessId' | 'tx'> = {}): OutboundService {
  return createOutboundService(env, { ...extra, businessId, tx: appCallTx });
}
