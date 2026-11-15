import { MOCK_LEADS, STATUS_LABEL, type MockLead } from '../../mock/leads';
import { StaffAuthError } from '../auth/staffAssertion';
import type { StaffIdentity } from '../auth/staffSession';

/**
 * 관리자 리드 조회 — 가상 데이터 전용(PHASE 1). 실제 DB 조회·쓰기·상태 변경·연락처 원문 복호화 없음.
 * 접근 범위
 * - owner: 전체
 * - counselor: 본인에게 배정된 건만(미배정·다른 직원 배정 건은 목록에 없고 상세는 '없음'과 같게 처리)
 * - reviewer·policy_editor: 업무상 승인된 조회 범위가 없으므로 거부(403)
 */
export type LeadSummary = Pick<MockLead, 'id' | 'createdAt' | 'nameMasked' | 'phoneMasked' | 'interest' | 'status' | 'assignee'> & { statusLabel: string };
export type LeadDetail = LeadSummary & Pick<MockLead, 'contactTime' | 'source' | 'notes'>;

type Scope = { kind: 'all' } | { kind: 'assigned'; staffId: string };

export function leadScope(identity: StaffIdentity): Scope {
  if (identity.role === 'owner') return { kind: 'all' };
  if (identity.role === 'counselor') return { kind: 'assigned', staffId: identity.actor };
  throw new StaffAuthError(403, 'FORBIDDEN');
}

const visible = (scope: Scope, lead: MockLead) => scope.kind === 'all' || lead.assigneeId === scope.staffId;

const summary = (l: MockLead): LeadSummary => ({
  id: l.id, createdAt: l.createdAt, nameMasked: l.nameMasked, phoneMasked: l.phoneMasked,
  interest: l.interest, status: l.status, statusLabel: STATUS_LABEL[l.status], assignee: l.assignee,
});

export function listMockLeads(identity: StaffIdentity, data: readonly MockLead[] = MOCK_LEADS): LeadSummary[] {
  const scope = leadScope(identity);
  return data.filter((l) => visible(scope, l)).map(summary);
}

const MOCK_ID = /^mock-\d{4}$/;

/** 없음·형식 오류·다른 직원 배정은 모두 null(존재 여부를 드러내지 않음) */
export function getMockLead(identity: StaffIdentity, id: unknown, data: readonly MockLead[] = MOCK_LEADS): LeadDetail | null {
  const scope = leadScope(identity);
  if (typeof id !== 'string' || !MOCK_ID.test(id)) return null;
  const lead = data.find((l) => l.id === id);
  if (!lead || !visible(scope, lead)) return null;
  return { ...summary(lead), contactTime: lead.contactTime, source: lead.source, notes: lead.notes.map((n) => ({ ...n })) };
}
