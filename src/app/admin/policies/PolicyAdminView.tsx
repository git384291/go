import { PublishPanel, RowActions, UploadPanel } from './PolicyConsole';

// 관리자 정책 화면(서버 컴포넌트). 고객 금액·수수료·원문 값은 목록에 싣지 않는다(상태·출처·유효기간·해시만).
export type PolicyRow = {
  id: string; supplier_id: string; segment: string; carrier: string; product_id: string; category: string; revision: number; state: string;
  source_kind: string; product_label: string; confirmed_at: string; valid_from: string; valid_until: string; content_hash: string;
  self_approval: boolean; decided_at: string | null; decision_reason: string | null;
};
const STATE: Record<string, string> = { draft: '초안', submitted: '검수 대기', approved: '승인·견적 사용', rejected: '반려', superseded: '대체됨' };
const SOURCE: Record<string, string> = {
  official_policy_sheet: '공식 정책표', distributor_notice: '공급처 공지', training_material: '교육 자료(견적 불가)',
  past_promotion: '과거 프로모션(견적 불가)', unverified_screenshot: '미확인 캡처(견적 불가)',
};
const ROLE: Record<string, string> = { owner: '대표', policy_editor: '정책 담당', reviewer: '검토자' };
const day = (s: string) => s.slice(0, 10);

export function PolicyAdminView({ items, role, publishOn }: { items: readonly PolicyRow[]; role: string; publishOn: boolean }) {
  const canUpload = role === 'owner' || role === 'policy_editor';
  return (
    <main className="admin-main" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />바른365 관리 · 정책</span>
        <span className="admin-bar-end"><span className="test-badge">로컬 시험 데이터</span><span className="admin-role">{ROLE[role] ?? role}</span></span>
      </header>
      <p className="muted">
        업로드 → 검증 → 검수 요청 → 대표 승인 순서입니다. 승인된 정책만 고객 상담 금액 안내에 쓰이며, 상담 연결 스위치는 현재 {publishOn ? '켜짐' : '꺼짐'}입니다.
        작성자와 승인자가 같으면 기록에 표시됩니다. 승인 권한은 서버와 DB가 판정합니다.
      </p>
      <PublishPanel enabled={publishOn} canChange={role === 'owner'} />
      {canUpload ? <UploadPanel /> : <p className="muted">이 역할은 조회만 가능합니다.</p>}
      <section aria-label="정책 목록">
        <h2>정책 목록</h2>
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table className="admin-table">
          <thead><tr><th>상품</th><th>공급처·통신사</th><th>출처</th><th>유효기간</th><th>상태</th><th>조작</th></tr></thead>
          <tbody>
            {items.length === 0 ? <tr><td colSpan={6}>등록된 정책이 없습니다.</td></tr> : items.map((p) => (
              <tr key={p.id}>
                <td>{p.product_label}<br /><small>{p.product_id} · r{p.revision} · {p.content_hash.slice(0, 8)}</small></td>
                <td>{p.supplier_id} / {p.carrier}</td>
                <td>{SOURCE[p.source_kind] ?? p.source_kind}<br /><small>확인 {day(p.confirmed_at)}</small></td>
                <td>{day(p.valid_from)} ~ {day(p.valid_until)}</td>
                <td>{STATE[p.state] ?? p.state}{p.self_approval ? ' (자기 승인)' : ''}{p.decision_reason ? <><br /><small>{p.decision_reason}</small></> : null}</td>
                <td><RowActions id={p.id} state={p.state} role={role} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>
    </main>
  );
}

export function PolicyLocked({ kind }: { kind: 'disabled' | 'forbidden' | 'failed' }) {
  const t = { disabled: '정책 관리가 아직 켜져 있지 않습니다.', forbidden: '이 화면을 볼 권한이 없습니다.', failed: '정책 목록을 불러오지 못했습니다.' }[kind];
  return <main className="admin-main"><p role="alert">{t}</p></main>;
}
