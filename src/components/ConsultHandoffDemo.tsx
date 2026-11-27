'use client';

import { useState } from 'react';
import { DEMO_CASES, DEMO_NOTE, DEMO_QUESTION, MOCK_BADGE, runDemoCase, type DemoCaseId } from '../content/consultHandoffDemo';

// 담당자 연결 모의 예시(비공개 시안 전용, PM 7029405014). 고정 사례를 고르면 안내가 하나만 보인다.
// 글자 입력칸·링크·전송·저장 없음. 상태는 이 컴포넌트 메모리에만 둔다.
export function ConsultHandoffDemo() {
  const [selected, setSelected] = useState<DemoCaseId | null>(null);
  const current = selected ? DEMO_CASES.find((c) => c.id === selected) : null;
  const result = selected ? runDemoCase(selected) : null;

  return (
    <div className="cp-handoff" data-handoff-demo="">
      <p className="cp-handoff-note">{DEMO_NOTE}</p>
      <p className="cp-example-ask">고객: {DEMO_QUESTION}</p>
      <div className="cp-handoff-cases" role="group" aria-label="담당자 연결 사례 선택">
        {DEMO_CASES.map((c) => (
          <button key={c.id} type="button" className="cp-choice cp-handoff-case" aria-pressed={selected === c.id} data-case={c.id} onClick={() => setSelected(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="cp-handoff-out" aria-live="polite">
        {current && result ? (
          <div className="cp-handoff-result" data-handoff-result={current.id}>
            <p className="cp-handoff-state">사례: {current.label}</p>
            <p className="cp-handoff-reply">
              AI 도우미: {result.text}
              {result.mock ? <span className="cp-handoff-mock">{MOCK_BADGE}</span> : null}
            </p>
            <p className="cp-handoff-events">{current.events}</p>
          </div>
        ) : (
          <p className="cp-handoff-empty">사례를 고르면 안내가 여기에 하나만 보여요.</p>
        )}
      </div>
    </div>
  );
}
