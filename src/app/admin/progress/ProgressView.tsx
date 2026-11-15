import { formatSeoul, isStale, type ProgressSnapshot } from '@/content/progress';

// 대표 전용 진행판 화면(서버 컴포넌트). 스냅샷은 owner 판정 뒤에만 전달된다.
export function ProgressView({ snapshot, now }: { snapshot: ProgressSnapshot; now: Date }) {
  const stale = isStale(snapshot, now);
  const mark = (p: boolean | null) => (p === true ? '통과' : p === false ? '실패' : '미확인');
  return (
    <div className="admin">
      <header className="admin-bar">
        <span className="brand brand-sm"><span className="brand-mark" aria-hidden="true" />FIDEON 진행 상황</span>
        <a className="admin-link" href="/admin">관리 화면</a>
      </header>
      <main className="admin-main progress">
        <p className={stale ? 'progress-stamp progress-stale' : 'progress-stamp'}>
          {formatSeoul(snapshot.checkedAt)} 확인 기준 · 실시간 아님{stale ? ` · ${snapshot.staleAfterHours}시간 넘게 갱신 안 됨` : ''}
        </p>
        <section aria-label="현재 단계">
          <h2>현재 단계</h2>
          <p>{snapshot.stage}</p>
        </section>
        <section aria-label="최근 완료">
          <h2>최근 완료</h2>
          <ul>{snapshot.recentDone.map((t) => <li key={t}>{t}</li>)}</ul>
        </section>
        <section aria-label="다음 작업">
          <h2>다음 작업</h2>
          <ul>{snapshot.next.map((t) => <li key={t}>{t}</li>)}</ul>
        </section>
        <section aria-label="검사">
          <h2>검사</h2>
          <ul className="progress-checks">
            {snapshot.checks.map((c) => (
              <li key={c.name}><span>{c.name}</span><b className={`pcheck pcheck-${mark(c.passed)}`}>{mark(c.passed)}</b></li>
            ))}
          </ul>
        </section>
        <section aria-label="영업 실적">
          <h2>영업 실적 (개발 진행과 별개)</h2>
          <p>{snapshot.sales.label}: <b>{snapshot.sales.value === null ? '미확인' : `${snapshot.sales.value}건`}</b></p>
        </section>
      </main>
    </div>
  );
}

const LOCK_TEXT: Record<'locked' | 'forbidden' | 'unavailable', string> = {
  locked: '이 화면은 관리자 인증 연결 후 열립니다.',
  forbidden: '이 화면을 볼 권한이 없습니다.',
  unavailable: '잠시 후 다시 시도해 주세요.',
};

/** 거부 화면: 상태 데이터를 받지도 그리지도 않는다 */
export function ProgressLocked({ kind }: { kind: 'locked' | 'forbidden' | 'unavailable' }) {
  return <main className="admin-locked">{LOCK_TEXT[kind]}</main>;
}
