import type { OfficialIntakeResult } from '@/content/officialIntake';

// 총판 공식 접수처 연결 표시. 꺼짐·빈 등록부·무효·해당 없음이면 아무것도 그리지 않는다(기존 준비 중 안내 유지).
// - 링크만 그린다. 폼·입력칸·외부 스크립트·iframe·이미지·사전 요청(prefetch)은 만들지 않는다.
// - 고객 정보는 FIDEON이 받지 않고, 고객이 공식 접수처 화면에서 직접 입력한다.
// - rel=noreferrer + referrerPolicy=no-referrer: 현재 페이지 주소(광고 파라미터 포함)를 목적지에 넘기지 않는다.
export function OfficialIntakeCta({ intake }: { intake: OfficialIntakeResult }) {
  if (intake.state !== 'on' || intake.links.length === 0) return null;
  return (
    <div className="official-intake" data-official-intake="on">
      <p className="official-intake-title">공식 접수처에서 직접 신청</p>
      <ul className="official-intake-list">
        {intake.links.map((l) => (
          <li key={l.id}>
            <a
              className="btn btn-primary btn-lg"
              href={l.href}
              rel="noopener noreferrer nofollow"
              referrerPolicy="no-referrer"
              target="_blank"
            >
              {l.label} 접수처로 이동
            </a>
            <span className="official-intake-host">이동 주소: {l.host}</span>
          </li>
        ))}
      </ul>
      <p className="official-intake-note">
        신청 정보는 이동한 공식 접수처 화면에서 직접 입력합니다. 바른365는 이 화면에서 이름·연락처·주소를 받지 않습니다.
        요금·혜택·설치 가능 여부는 접수처에서 확인되는 조건을 따릅니다.
      </p>
    </div>
  );
}
