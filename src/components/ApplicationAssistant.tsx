'use client';

import { useState } from 'react';
import { APPLICATION_FIELDS, labelOf, missingApplication, neededFields, nextQuestion, validateApplication, type Application, type FieldDef } from '../content/applicationForm';

// AI 신청서 도우미(고객 화면). 정해진 질문을 한 항목씩 묻고, 빠진 항목을 알려 준다. 답은 이 화면 메모리에만 있다가 접수 양식과 함께 서버로 간다.
// 질문·검사는 고정 규칙이다(AI 모델이 고객 답을 보지 않는다). 주민등록번호·자동이체·계좌정보는 묻지도 받지도 않으며, 닿으면 입력을 거부한다.
const SENSITIVE_MSG = '주민등록번호·계좌·카드·자동이체 정보는 여기에 입력할 수 없습니다. 총판이 별도로 확인합니다.';
const valueLabel = (f: FieldDef, v: string) => f.options?.find((o) => o.value === v)?.label ?? v;

export function ApplicationAssistant({ app, onChange }: { app: Application; onChange: (a: Application) => void }) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const current = nextQuestion(app);
  const missing = missingApplication(app).filter((k) => !['carrier', 'productId', 'regionCode'].includes(k));
  const total = neededFields(app).length;
  const done = total - missing.length;

  function answer(f: FieldDef, raw: string) {
    const v = validateApplication({ [f.key]: raw });
    if (!v.ok) { setErr(v.code === 'SENSITIVE_INPUT' ? SENSITIVE_MSG : '입력을 확인해 주세요.'); return; }
    setErr(''); setDraft('');
    onChange({ ...app, ...(v.value as Application) });
  }
  function clear(key: FieldDef['key']) {
    const next = { ...app } as Record<string, string | undefined>;
    delete next[key];
    onChange(next as Application);
  }

  return (
    <section className="consent-box" aria-label="AI 신청서 도우미">
      <h3>AI 신청서 도우미</h3>
      <p className="field-hint">가입 신청서를 만들기 위해 필요한 정보를 한 가지씩 여쭤봅니다. <b>주민번호·자동이체·사은품계좌는 묻지 않으며 입력하지 마세요.</b> 총판이 따로 확인합니다.</p>
      <p role="status" data-field="assistant-progress">필수 {done}/{total} 항목 완료{missing.length > 0 ? ` · 아직 필요한 항목: ${missing.map(labelOf).join(', ')}` : ' · 필수 항목이 모두 채워졌습니다'}</p>
      <ol style={{ paddingLeft: 18, margin: '8px 0' }}>
        {APPLICATION_FIELDS.filter((f) => f.key !== 'installDate' || app.installPref === 'date').map((f) => {
          const v = (app as Record<string, string | undefined>)[f.key];
          const isCurrent = current?.key === f.key;
          return (
            <li key={f.key} data-field={f.key}>
              <b>{f.label}{f.required ? '' : ' (선택)'}</b>{' '}
              {v ? <><span data-answer>{f.kind === 'select' ? valueLabel(f, v) : v}</span> <button type="button" onClick={() => clear(f.key)} aria-label={`${f.label} 수정`}>수정</button></> : isCurrent ? (
                <div>
                  <p>AI 도우미: {f.question}</p>
                  {f.kind === 'select' ? (
                    <div role="group" aria-label={f.label}>{f.options!.map((o) => <button key={o.value} type="button" onClick={() => answer(f, o.value)}>{o.label}</button>)}</div>
                  ) : (
                    <div><input aria-label={f.label} value={draft} maxLength={f.max} onChange={(e) => { setDraft(e.target.value); setErr(''); }} />{' '}
                      <button type="button" disabled={draft.trim().length === 0} onClick={() => answer(f, draft)}>답하기</button></div>
                  )}
                </div>
              ) : <span className="muted">{f.required ? '(대기)' : '(선택)'}</span>}
            </li>
          );
        })}
      </ol>
      {err && <span className="field-error" role="alert">{err}</span>}
    </section>
  );
}
