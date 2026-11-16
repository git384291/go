import type { ReactNode } from 'react';
import type { MaskedLead } from '@/server/admin/leadsReadStore';

// 로컬 시험용 읽기 전용 목록(db 출처). 서버 컴포넌트: 브라우저 코드·외부 요청·저장소 없음.
// 7키 마스킹 DTO만 받는다. 상세·원문 보기·메모·배정·상태 수정·내보내기 없음.
// 이 목록은 지정된 로컬 폐기 시험 DB의 가상 데이터이며 실제 영업 실적이 아니다(건수·통계를 만들지 않는다).

const STATUS_LABEL: Record<MaskedLead['status'], string> = {
  new: '신규', contacting: '연락중', consulted: '상담완료', no_answer: '부재', declined: '거절', converted: '접수전환',
};
const INTEREST_LABEL: Record<string, string> = { internet_tv: '인터넷+TV' };

function Bar({ headerExtra }: { headerExtra?: ReactNode }) {
  return (
    <header className="admin-bar">
      <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 관리</span>
      <span className="admin-bar-end">
        <span className="test-badge">로컬 시험 데이터</span>
        {headerExtra}
      </span>
    </header>
  );
}

function assignLabel(assignedTo: string | null, actor: string): string {
  if (assignedTo === null) return '미배정';
  return assignedTo === actor ? '내 배정' : '배정됨';
}

function fmt(iso: string): string {
  // 서버에서 고정 형식으로만 표시(KST). 원문 그대로 노출하지 않는다
  const d = new Date(iso);
  const k = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

export type LeadsReadViewProps = {
  items: readonly MaskedLead[];
  actor: string;
  offset: number;
  limit: number;
  headerExtra?: ReactNode;
};

export function LeadsReadView({ items, actor, offset, limit, headerExtra }: LeadsReadViewProps) {
  const hasPrev = offset > 0;
  const hasNext = items.length === limit;
  return (
    <div className="admin">
      <Bar headerExtra={headerExtra} />
      <main className="admin-main">
        <p className="read-note">로컬 시험 DB의 가상 목록(읽기 전용)입니다. 실제 고객·영업 실적이 아니며, 전체 건수는 표시하지 않습니다.</p>
        {items.length === 0 ? (
          <p className="read-empty" role="status">{hasPrev ? '이 페이지에 표시할 상담이 없습니다.' : '표시할 상담이 없습니다.'}</p>
        ) : (
          <ul className="lead-list" aria-label="상담 목록(읽기 전용)">
            {items.map((l) => (
              <li key={l.id} className="lead-row">
                <div className="lead-main">
                  <span className="lead-name">{l.nameMasked}</span>
                  <span className="lead-phone">{l.phoneMasked}</span>
                </div>
                <div className="lead-meta">
                  <span>{INTEREST_LABEL[l.interest] ?? '확인 필요'}</span>
                  <span>{fmt(l.createdAt)}</span>
                  <span>{assignLabel(l.assignedTo, actor)}</span>
                </div>
                <span className={`status status-${l.status}`}>{STATUS_LABEL[l.status]}</span>
              </li>
            ))}
          </ul>
        )}
        {(hasPrev || hasNext) && (
          <nav className="read-pager" aria-label="페이지 이동">
            {hasPrev ? <a href={`/admin?offset=${Math.max(0, offset - limit)}`}>이전</a> : <span />}
            {hasNext ? <a href={`/admin?offset=${offset + limit}`}>다음</a> : <span />}
          </nav>
        )}
        {hasNext && <p className="read-note">다음 페이지가 있을 수 있습니다(전체 건수 미확인).</p>}
      </main>
    </div>
  );
}

export type LeadsLockedKind = 'source' | 'not_ready' | 'auth_off' | 'forbidden' | 'failed';
const LOCKED_TEXT: Record<LeadsLockedKind, string> = {
  source: '관리자 목록 설정을 확인할 수 없어 화면을 잠갔습니다.',
  not_ready: '이 환경에서는 목록을 불러오지 않습니다(로컬 시험 DB 준비 전).',
  auth_off: '관리자 화면은 인증 연결 후 열립니다.',
  forbidden: '이 계정은 상담 목록을 볼 수 없습니다.',
  failed: '목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export function LeadsReadLocked({ kind, headerExtra }: { kind: LeadsLockedKind; headerExtra?: ReactNode }) {
  return (
    <div className="admin">
      <Bar headerExtra={headerExtra} />
      <main className="admin-locked" role={kind === 'failed' ? 'alert' : 'status'}>{LOCKED_TEXT[kind]}</main>
    </div>
  );
}
