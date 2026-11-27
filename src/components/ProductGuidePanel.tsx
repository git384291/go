import { answerGuide, guideMenu, type GuideKind } from '@/content/productGuide';
import type { OfficialIntakeResult } from '@/content/officialIntake';
import { OfficialIntakeCta } from '@/components/OfficialIntakeCta';

// 선택형 상품 안내(규칙 기반, PM 6925800166). 서버에서 9개 고정 질문·응답을 미리 그리고,
// 펼침은 브라우저 기본 details/summary로만 한다(클라이언트 JS·폼·입력칸·요청·주소 변경 없음).
// - AI 상담·상담원 연결이 아니다. 고객 입력을 받지 않으며 응답은 미리 정한 고정 문구다.
// - 신청 안내는 서버가 이미 판정한 공식 접수 결과(intake)만 따른다. 꺼짐이면 준비 중 안내만 보인다.
const KIND_LABEL: Record<GuideKind, string | null> = { general: null, needs_check: '확인 필요', not_ready: '준비 중' };

export function ProductGuidePanel({ intake }: { intake: OfficialIntakeResult }) {
  return (
    <section className="section product-guide" data-product-guide="on" aria-labelledby="product-guide-title">
      <h2 id="product-guide-title" className="section-title">자주 묻는 질문</h2>
      <p className="section-note">미리 정해 둔 규칙 기반 상품 안내입니다. 질문을 입력받지 않으며, 상담원 연결이나 신청 접수가 아닙니다.</p>
      <div className="guide-list">
        {guideMenu().map((m) => {
          const a = answerGuide({ product: 'internet-tv', topic: m.topic }, intake);
          if (a.status !== 'ok') return null;
          const tag = KIND_LABEL[a.kind];
          return (
            <details key={a.topic} className="guide-item" data-guide-topic={a.topic}>
              <summary>
                <span className="guide-q">{a.title}</span>
                {tag && <span className="guide-tag">{tag}</span>}
              </summary>
              <div className="guide-answer">
                {a.lines.map((l) => (
                  <p key={l}>{l}</p>
                ))}
                {a.topic === 'apply' && a.officialIntake === 'available' && <OfficialIntakeCta intake={intake} />}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
