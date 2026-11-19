'use client';

import { useEffect, useRef, useState } from 'react';
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
  PHONE_VS_VISIT_NOTE,
  PRIVACY_FAQ,
  SEGMENT_QUESTION,
  SEGMENTS,
  VIRTUAL_NOTICE,
  type Segment,
} from '../content/consultPreview';

// 모바일 웹 상담 비공개 시안(가상 대화). PM 7011892065, 7014853871, 7014881513.
// - 글자 입력칸 없음(보기에서 고르기만). 외부 전송·저장·분석·실제 AI 호출 없음. 상태는 이 컴포넌트 메모리에만 둔다.
// - 화면 구성: 현재 질문과 선택지가 항상 바로 보이고, 이전 답은 접어 두었다가 펼쳐서 고친다.
// - 키보드 초점: 답을 고르면 다음 질문(또는 요약)으로, 이전 답을 고치면 그 질문으로 옮긴다.
// - 전화 안내는 한국 시간 기준 토요일 가상 영업시간 안에서만 모의 버튼. 실제 전화·번호·링크 없음.
// - now: 시험에서 시각을 고정할 때만 넘긴다. 넘기지 않으면 브라우저 시계를 쓰고, 마운트 전에는 전화 안내를 그리지 않는다.
export function ConsultPreviewChat({ now }: { now?: Date }) {
  const [segment, setSegment] = useState<Segment | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [clock, setClock] = useState<Date | null>(now ?? null);
  const [mockCalled, setMockCalled] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 초점 이동: 값이 바뀔 때마다(처음 0은 제외) 지금 보여 주는 질문·요약 제목으로 초점을 옮긴다
  const [focusTick, setFocusTick] = useState(0);
  const focusRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (now) {
      setClock(now);
      return;
    }
    setClock(new Date());
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [now]);

  useEffect(() => {
    if (focusTick > 0) focusRef.current?.focus();
  }, [focusTick]);

  const flow = segment ? FLOWS[segment] : null;
  const complete = segment ? isComplete(segment, picks) : false;
  const stepIndex = flow ? Math.min(picks.length, flow.steps.length) : 0;
  const currentStep = flow && !complete ? flow.steps[stepIndex] : null;
  const summary = segment && complete ? buildSummary(segment, picks) : null;
  const phone = clock ? phoneState(clock) : { kind: 'hidden' as const };

  // 방금 고른 답에 대한 AI 도우미의 안내(현재 질문 바로 위에 보여 준다)
  const lastStep = flow && picks.length > 0 ? flow.steps[picks.length - 1] : null;
  const lastChoice = lastStep ? lastStep.choices.find((c) => c.id === picks[picks.length - 1]) : null;

  const chooseSegment = (s: Segment) => {
    setSegment(s);
    setPicks([]);
    setHistoryOpen(false);
    setFocusTick((n) => n + 1);
  };
  const choose = (choiceId: string) => {
    setPicks((prev) => [...prev.slice(0, stepIndex), choiceId]);
    setFocusTick((n) => n + 1);
  };
  // 이전 선택을 고치면 그 뒤 선택은 지우고 그 질문부터 다시 묻는다(요약도 함께 다시 계산된다)
  const editStep = (i: number) => {
    setPicks((prev) => prev.slice(0, i));
    setHistoryOpen(false);
    setFocusTick((n) => n + 1);
  };
  const editSegment = () => {
    setSegment(null);
    setPicks([]);
    setHistoryOpen(false);
    setFocusTick((n) => n + 1);
  };

  const answered = flow ? flow.steps.map((step, i) => ({ step, i, choice: step.choices.find((c) => c.id === picks[i]) })).filter((x) => x.choice) : [];
  const historyCount = (segment ? 1 : 0) + answered.length;

  const notices = (
    <section className="cp-notices" aria-label="안내">
      <p className="cp-notice cp-notice-ai">{AI_NOTICE}</p>
      <p className="cp-notice">{VIRTUAL_NOTICE}</p>
    </section>
  );

  return (
    <div className="cp-wrap">
      <header className="cp-head">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          FIDEON
        </span>
        <span className="cp-badge">AI 도우미 · 가상 대화 시안</span>
      </header>

      {segment === null ? (
        <>
          <section className="cp-start cp-now" aria-label="용도 선택">
            <h1 className="cp-hero-q" tabIndex={-1} ref={focusRef}>
              {SEGMENT_QUESTION}
            </h1>
            <div className="cp-choices" role="group" aria-label="용도 선택">
              {SEGMENTS.map((s) => (
                <button key={s.id} type="button" className="cp-choice" onClick={() => chooseSegment(s.id)}>
                  <strong>{s.label}</strong>
                  <span>{s.hint}</span>
                </button>
              ))}
            </div>
          </section>
          {notices}
        </>
      ) : (
        <div aria-live="polite" className="cp-chat">
          {summary ? (
            <section className="cp-summary cp-now" aria-label="선택 요약">
              <p className="cp-keypoint" data-keypoint="">
                <span className="cp-keypoint-label">가장 먼저 비교할 점</span>
                <strong>{summary.keyPoint.point}</strong>
                <span className="cp-keypoint-reason">{summary.keyPoint.reason}</span>
              </p>
              <h2 tabIndex={-1} ref={focusRef}>
                선택한 조건 정리
              </h2>
              <h3>선택 조건</h3>
              <ul>
                {summary.conditions.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <h3>비용 구분</h3>
              <ul className="cp-costs">
                {summary.costs.map((c) => (
                  <li key={c.title}>
                    <strong>{c.title}</strong>
                    <span>{c.items}</span>
                    <span className="cp-cost-status">{c.status}</span>
                  </li>
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
              <p className="cp-summary-note">이 정리는 견적이나 접수가 아니에요. 금액·일정은 확정되지 않았고, 아래에서 이전 답을 고치면 이 정리도 바뀌어요.</p>
            </section>
          ) : null}

          {currentStep ? (
            <section className="cp-current cp-now" data-step={currentStep.id} aria-label="현재 질문">
              <p className="cp-progress">
                {flow?.label} · 질문 {stepIndex + 1}/{flow?.steps.length}
              </p>
              {lastChoice ? (
                <div className="cp-bubble cp-bot" data-reply="">
                  <p>{lastChoice.reply}</p>
                </div>
              ) : null}
              <h2 className="cp-question" tabIndex={-1} ref={focusRef}>
                {currentStep.question}
              </h2>
              <div className="cp-choices" role="group" aria-label={currentStep.question}>
                {currentStep.choices.map((c) => (
                  <button key={c.id} type="button" className="cp-choice" onClick={() => choose(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <details className="cp-fold cp-history" open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
            <summary>
              이전 답 {historyCount}개 보기·고치기
            </summary>
            <ol className="cp-history-list">
              <li>
                <p className="cp-hq">{SEGMENT_QUESTION}</p>
                <div className="cp-answer-row">
                  <span className="cp-answer">{flow?.label}</span>
                  <button type="button" className="cp-edit" onClick={editSegment} aria-label="가정용·매장 사무실용 선택 고치기">
                    고치기
                  </button>
                </div>
              </li>
              {answered.map(({ step, i, choice }) => (
                <li key={step.id}>
                  <p className="cp-hq">{step.question}</p>
                  <div className="cp-answer-row">
                    <span className="cp-answer">{choice?.label}</span>
                    <button type="button" className="cp-edit" onClick={() => editStep(i)} aria-label={`${step.question} 선택 고치기`}>
                      고치기
                    </button>
                  </div>
                  <p className="cp-hreply">{choice?.reply}</p>
                </li>
              ))}
            </ol>
          </details>

          {notices}
        </div>
      )}

      {phone.kind !== 'hidden' ? (
        <section className="cp-phone" aria-label="전화 안내(모의)">
          <h2>전화 안내(모의)</h2>
          {phone.kind === 'mock_open' ? (
            <>
              <p>{MOCK_SATURDAY_HOURS_TEXT} 안이에요.</p>
              <button type="button" className="btn btn-ghost btn-block" onClick={() => setMockCalled(true)}>
                모의 전화 버튼
              </button>
              {mockCalled ? (
                <p className="cp-mock-result" role="status">
                  {MOCK_CALL_RESULT}
                </p>
              ) : null}
            </>
          ) : (
            <p>전화 상담은 {MOCK_SATURDAY_HOURS_TEXT}에만 안내해요. 지금은 전화 버튼을 보여 드리지 않아요.</p>
          )}
          <p className="cp-phone-note">{PHONE_VS_VISIT_NOTE}</p>
        </section>
      ) : null}

      <details className="cp-fold cp-aux" data-aux="examples">
        <summary>이런 질문엔 이렇게 답해요 ({EXAMPLES.length})</summary>
        {EXAMPLES.map((ex) => (
          <div key={ex.title} className="cp-example">
            <p className="cp-example-title">{ex.title}</p>
            <p className="cp-example-ask">고객: {ex.ask}</p>
            <p className="cp-example-ans">AI 도우미: {ex.answer}</p>
          </div>
        ))}
      </details>

      <details className="cp-fold cp-aux" data-aux="faq">
        <summary>자주 묻는 질문 ({FAQ.length})</summary>
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
      </details>

      <details className="cp-fold cp-aux" data-aux="privacy">
        <summary>개인정보 안내 ({PRIVACY_FAQ.length})</summary>
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
      </details>
    </div>
  );
}
