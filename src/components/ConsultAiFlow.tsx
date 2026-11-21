'use client';

import { useState } from 'react';
import type { Application } from '../content/applicationForm';
import { ApplicationAssistant } from './ApplicationAssistant';
import { ConsultAiChat, type ChatChoice } from './ConsultAiChat';
import { ConsultForm, type ConsultOption } from './ConsultForm';

// AI 상담 → 신청서 누락정보 수집 연결. 신청서 답은 이 컴포넌트가 하나만 들고(기존 ApplicationAssistant·검증기 그대로),
// 채팅은 AI 답변 뒤에 빠진 필수 항목을 순서대로 이어 묻고, 접수 양식은 같은 답을 함께 보낸다. 고객 답은 AI 채팅 서버로 가지 않는다.
export function ConsultAiFlow({ choice, options, kakaoUrl }: { choice: ChatChoice; options: readonly ConsultOption[]; kakaoUrl: string | null }) {
  const [app, setApp] = useState<Application>({});
  return (
    <>
      <section className="section"><ConsultAiChat choice={choice} application={{ ...choice, ...app }} /></section>
      <section className="section" id="assistant"><ApplicationAssistant app={app} onChange={setApp} /></section>
      <section className="section" id="apply" aria-label="가입 상담 신청">
        <ConsultForm options={options} kakaoUrl={kakaoUrl} choice={choice} app={app} />
      </section>
    </>
  );
}
