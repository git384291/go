'use client';

import { useEffect, useState } from 'react';
import {
  AI_NOTICE,
  buildSummary,
  EXAMPLES,
  FAQ,
  FLOWS,
  isComplete,
  MOCK_CALL_RESULT,
  MOCK_SATURDAY_HOURS_TEXT,
  phoneState,
  PRIVACY_FAQ,
  SEGMENT_QUESTION,
  SEGMENTS,
  VIRTUAL_NOTICE,
  type Segment,
} from '../content/consultPreview';

// 모바일 웹 상담 비공개 시안(가상 대화). PM 7011892065.
// - 글자 입력칸 없음(보기에서 고르기만). 외부 전송·저장·분석·실제 AI 호출 없음. 상태는 이 컴포넌트 메모리에만 둔다.
// - 전화 안내는 한국 시간 기준 토요일 가상 영업시간 안에서만 모의 버튼. 실제 전화·번호·링크 없음.
// - now: 시험에서 시각을 고정할 때만 넘긴다. 넘기지 않으면 브라우저 시계를 쓰고, 마운트 전에는 전화 안내를 그리지 않는다.
export function ConsultPreviewChat({ now }: { now?: Date }) {
  const [segment, setSegment] = useState<Segment | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [clock, setClock] = useState<Date | null>(now ?? null);
  const [mockCalled, setMockCalled] = useState(false);

  useEffect(() => {
    if (now) {
      setClock(now);
      return;
    }
    setClock(new Date());
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [now]);

  const flow = segment ? FLOWS[segment] : null;
  const complete = segment ? isComplete(segment, picks) : false;
  const stepIndex = flow ? Math.min(picks.length, flow.steps.length) : 0;
  const currentStep = flow && !complete ? flow.steps[stepIndex] : null;
  const summary = segment && complete ? buildSummary(segment, picks) : null;
  const phone = clock ? phoneState(clock) : { kind: 'hidden' as const };

  const chooseSegment = (s: Segment) => {
    setSegment(s);
    setPicks([]);
  };
  const choose = (choiceId: string) => setPicks((prev) => [...prev.slice(0, stepIndex), choiceId]);
  // 이전 선택을 고치면 그 뒤 선택은 지우고 그 질문부터 다시 묻는다(요약도 함께 다시 계산된다)
  const editStep = (i: number) => setPicks((prev) => prev.slice(0, i));
  const editSegment = () => {
    setSegment(null);
    setPicks([]);
  };

  return (
    <div className="cp-wrap">
      <header className="cp-head">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          FIDEON
        </span>
        <span className="cp-badge">AI 도우미 · 가상 대화 시안</span>
      </header>

      <section className="cp-notices" aria-label="안내">
        <p className="cp-notice cp-notice-ai">{AI_NOTICE}</p>
        <p className="cp-notice">{VIRTUAL_NOTICE}</p>
      </section>

      <section className="cp-chat" aria-live="polite" aria-label="상담 대화">
        <div className="cp-bubble cp-bot">
          <p className="cp-q">{SEGMENT_QUESTION}</p>
        </div>

        {segment === null ? (
          <div className="cp-choices" role="group" aria-label="용도 선택">
            {SEGMENTS.map((s) => (
              <button key={s.id} type="button" className="cp-choice" onClick={() => chooseSegment(s.id)}>
                <strong>{s.label}</strong>
                <span>{s.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="cp-answer-row">
            <span className="cp-answer">{flow?.label}</span>
            <button type="button" className="cp-edit" onClick={editSegment} aria-label="가정용·매장 사무실용 선택 고치기">
              고치기
            </button>
          </div>
        )}

        {flow?.steps.map((step, i) => {
          const pickedId = picks[i];
          const picked = step.choices.find((c) => c.id === pickedId);
          if (!picked) return null;
          return (
            <div key={step.id} className="cp-turn">
              <div className="cp-bubble cp-bot">
                <p className="cp-q">{step.question}</p>
              </div>
              <div className="cp-answer-row">
                <span className="cp-answer">{picked.label}</span>
                <button type="button" className="cp-edit" onClick={() => editStep(i)} aria-label={`${step.question} 선택 고치기`}>
                  고치기
                </button>
              </div>
              <div className="cp-bubble cp-bot">
                <p>{picked.reply}</p>
              </div>
            </div>
          );
        })}

        {currentStep ? (
          <div className="cp-turn" data-step={currentStep.id}>
            <div className="cp-bubble cp-bot">
              <p className="cp-q">{currentStep.question}</p>
            </div>
            <div className="cp-choices" role="group" aria-label={currentStep.question}>
              {currentStep.choices.map((c) => (
                <button key={c.id} type="button" className="cp-choice" onClick={() => choose(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {summary ? (
        <section className="cp-summary" aria-label="선택 요약">
          <h2>선택한 조건 정리</h2>
          <h3>선택 조건</h3>
          <ul>
            {summary.conditions.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <h3>확인된 일반 안내</h3>
          <ul>
            {summary.general.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <h3>확인할 항목</h3>
          <ul>
            {summary.toCheck.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="cp-summary-note">이 정리는 견적이나 접수가 아니에요. 금액·일정은 확정되지 않았고, 위의 선택을 고치면 이 정리도 바뀌어요.</p>
        </section>
      ) : null}

      {phone.kind !== 'hidden' ? (
        <section className="cp-phone" aria-label="전화 안내(모의)">
          <h2>전화 안내(모의)</h2>
          {phone.kind === 'mock_open' ? (
            <>
              <p>{MOCK_SATURDAY_HOURS_TEXT} 안이에요.</p>
              <button type="button" className="btn btn-ghost btn-block" onClick={() => setMockCalled(true)}>
                모의 전화 버튼
              </button>
              {mockCalled ? <p className="cp-mock-result" role="status">{MOCK_CALL_RESULT}</p> : null}
            </>
          ) : (
            <p>전화 상담은 {MOCK_SATURDAY_HOURS_TEXT}에만 안내해요. 지금은 전화 버튼을 보여 드리지 않아요.</p>
          )}
        </section>
      ) : null}

      <section className="cp-section" aria-label="상담 예시">
        <h2>이런 질문엔 이렇게 답해요</h2>
        {EXAMPLES.map((ex) => (
          <div key={ex.title} className="cp-example">
            <p className="cp-example-title">{ex.title}</p>
            <p className="cp-example-ask">고객: {ex.ask}</p>
            <p className="cp-example-ans">AI 도우미: {ex.answer}</p>
          </div>
        ))}
      </section>

      <section className="cp-section" aria-label="자주 묻는 질문">
        <h2>자주 묻는 질문</h2>
        <div className="guide-list">
          {FAQ.map((f) => (
            <details key={f.q} className="guide-item">
              <summary>
                <span className="guide-q">{f.q}</span>
              </summary>
              <div className="guide-answer">
                <p>{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="cp-section" aria-label="개인정보 안내">
        <h2>개인정보 안내</h2>
        <div className="guide-list">
          {PRIVACY_FAQ.map((f) => (
            <details key={f.q} className="guide-item">
              <summary>
                <span className="guide-q">{f.q}</span>
              </summary>
              <div className="guide-answer">
                <p>{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
