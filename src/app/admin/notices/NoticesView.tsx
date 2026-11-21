import { NoticeAddPanel } from './NoticesConsole';

// 필수 고지 문구 입력·버전 관리 화면(서버 컴포넌트). 임의 문구를 넣어 두지 않는다 — 실제 문구는 대표·PM이 확정해 입력한다.
// 문구를 DB에 넣어도 접수는 열리지 않는다: 접수는 코드 상수 REQUIRED_NOTICES가 '확정'으로 바뀔 때만(별도 승인·배포) 열린다.
export type NoticeRow = { version: string; notice_key: string; body: string; body_sha256: string; created_at: string };
export type NoticeStatus = { ready: boolean; reason: string | null; codeVersion: string; mismatches: readonly string[] };
const REASON: Record<string, string> = {
  NOTICE_NOT_CONFIRMED: '실제 문구가 아직 확정되지 않았습니다', NOTICE_VERSION_MISMATCH: '고지 버전과 처리방침 버전이 다릅니다',
  NOTICE_EMPTY: '필수 항목이 비어 있습니다', NOTICE_INVALID: '항목 형식이 올바르지 않습니다', NO_DB_TEXTS: 'DB에 이 버전의 문구가 없습니다',
};
const day = (s: string) => String(s).slice(0, 10);

export function NoticesView({ rows, role, status }: { rows: readonly NoticeRow[]; role: string; status: NoticeStatus }) {
  const versions = Array.from(new Set(rows.map((r) => r.version)));
  return (
    <main className="admin-main" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 관리 · 필수 고지</span>
        <span className="admin-bar-end"><span className="test-badge">로컬 시험 데이터</span><span className="admin-role">{role === 'owner' ? '대표' : '검토자'}</span></span>
      </header>
      <section className="admin-card" aria-label="접수 상태" role="status">
        <h2>접수 상태</h2>
        <p data-field="intake"><strong>{status.ready ? '고지 확정됨(접수 개방은 별도 승인 필요)' : '접수 차단 유지'}</strong>{status.reason ? ` — ${REASON[status.reason] ?? status.reason}` : ''}</p>
        <p className="muted">고객 접수는 코드의 필수 고지 상수가 확정으로 바뀌고 DB 문구와 일치할 때만 열립니다. 아래 입력은 문구를 DB에 쌓을 뿐 접수를 열지 않습니다.</p>
        <p className="muted" data-field="match">{status.codeVersion === '' ? '코드 상수 버전: 없음' : `코드 상수 버전 ${status.codeVersion} · DB 대조: ${status.mismatches.length === 0 ? '일치' : status.mismatches.map((m) => REASON[m] ?? m).join(', ')}`}</p>
      </section>
      {role === 'owner' ? <NoticeAddPanel /> : <p className="muted">문구 입력은 대표만 할 수 있습니다(조회만 가능).</p>}
      <section aria-label="고지 문구 버전">
        <h2>저장된 고지 문구</h2>
        {versions.length === 0 ? <p>저장된 문구가 없습니다. 실제 문구가 확정되면 대표가 버전과 함께 입력합니다.</p> : versions.map((v) => (
          <div key={v} className="admin-card" data-version={v}>
            <h3>버전 {v}</h3>
            <table className="admin-table">
              <thead><tr><th>항목 키</th><th>문구</th><th>해시</th><th>입력일</th></tr></thead>
              <tbody>{rows.filter((r) => r.version === v).map((r) => <tr key={r.notice_key}><td>{r.notice_key}</td><td>{r.body}</td><td><small>{r.body_sha256.slice(0, 8)}</small></td><td>{day(r.created_at)}</td></tr>)}</tbody>
            </table>
          </div>
        ))}
        <p className="muted">저장된 문구는 수정·삭제할 수 없습니다. 바꾸려면 새 버전으로 입력합니다.</p>
      </section>
    </main>
  );
}

export function NoticesLocked({ kind }: { kind: 'disabled' | 'forbidden' | 'failed' }) {
  const text = { disabled: '필수 고지 화면은 아직 열려 있지 않습니다.', forbidden: '이 화면을 볼 권한이 없습니다.', failed: '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }[kind];
  return <main className="admin-main"><p role="status">{text}</p></main>;
}
