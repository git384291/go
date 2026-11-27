import type { ReactNode } from 'react';
import { MOCK_LEADS, STATUS_LABEL } from '@/mock/leads';

// REV-004: 관리자 UI는 가상 데이터로만 구현(실제 리드 조회 API는 별도 작업).
// headerExtra: 인증된 경우 역할 표시·로그아웃 버튼.
export function AdminMockView({ headerExtra }: { headerExtra?: ReactNode }) {
  const counts = MOCK_LEADS.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});
  const selected = MOCK_LEADS[1];

  return (
    <div className="admin">
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />바른365 관리</span>
        <span className="admin-bar-end">
          <span className="mock-badge">가상 데이터</span>
          {headerExtra}
        </span>
      </header>

      <main className="admin-main">
        <section className="admin-kpis" aria-label="오늘 현황">
          <div><b>{counts.new ?? 0}</b><span>신규</span></div>
          <div><b>{(counts.contacting ?? 0) + (counts.no_answer ?? 0)}</b><span>연락 필요</span></div>
          <div><b>{counts.converted ?? 0}</b><span>접수전환</span></div>
        </section>

        <div className="filter-row" role="tablist" aria-label="상태 필터">
          <button className="chip chip-on" role="tab" aria-selected="true">전체 {MOCK_LEADS.length}</button>
          {(['new', 'contacting', 'no_answer', 'consulted'] as const).map((s) => (
            <button key={s} className="chip" role="tab" aria-selected="false">{STATUS_LABEL[s]} {counts[s] ?? 0}</button>
          ))}
        </div>

        <ul className="lead-list">
          {MOCK_LEADS.map((l) => (
            <li key={l.id} className={l.id === selected.id ? 'lead-row lead-row-on' : 'lead-row'}>
              <div className="lead-main">
                <span className="lead-name">{l.nameMasked}</span>
                <span className="lead-phone">{l.phoneMasked}</span>
              </div>
              <div className="lead-meta">
                <span>{l.interest}</span>
                <span>{l.createdAt}</span>
                <span>{l.assignee}</span>
              </div>
              <span className={`status status-${l.status}`}>{STATUS_LABEL[l.status]}</span>
            </li>
          ))}
        </ul>

        <section className="lead-detail" aria-label="선택한 상담">
          <h2>{selected.nameMasked} · {selected.phoneMasked}</h2>
          <p className="detail-sub">{selected.interest} · 연락 희망 {selected.contactTime || '없음'} · 유입 {selected.source}</p>
          <div className="reveal">
            <label className="field">
              <span>원문 보기 사유 <em>(필수, 기록됨)</em></span>
              <input placeholder="예: 고객 요청 회신 전화" disabled />
            </label>
            <button className="btn btn-ghost" disabled>연락처 원문 보기</button>
            <p className="hint">원문 조회는 배정된 상담만 가능하며 1시간 30건으로 제한됩니다.</p>
          </div>
          <label className="field">
            <span>상태</span>
            <select defaultValue={selected.status} disabled>
              <option value="contacting">연락중</option>
              <option value="consulted">상담완료</option>
              <option value="no_answer">부재</option>
              <option value="declined">거절</option>
            </select>
          </label>
          <h3>메모</h3>
          <ul className="notes">
            {selected.notes.map((n) => (
              <li key={n.at}><span>{n.at} · {n.by}</span>{n.body}</li>
            ))}
          </ul>
          <textarea className="note-input" placeholder="메모 추가" rows={3} disabled />
        </section>
      </main>
    </div>
  );
}
