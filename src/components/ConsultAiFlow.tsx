'use client';

import { useState } from 'react';
import type { Application } from '../content/applicationForm';
import { ApplicationAssistant } from './ApplicationAssistant';
import { ConsultAiChat, type ChatChoice } from './ConsultAiChat';
import { ConsultForm, type ConsultOption } from './ConsultForm';
import { noticeReadiness, REQUIRED_NOTICES } from '../content/requiredNotices';
import { POLICY_UNVERIFIED_GUIDANCE } from '../content/consultGuidance';

// AI 상담 → 신청서 누락정보 수집 연결. 신청서 답은 이 컴포넌트가 하나만 들고(기존 ApplicationAssistant·검증기 그대로),
// 채팅은 AI 답변 뒤에 빠진 필수 항목을 순서대로 이어 묻고, 접수 양식은 같은 답을 함께 보낸다. 고객 답은 AI 채팅 서버로 가지 않는다.
export function ConsultAiFlow({ choice, options, kakaoUrl }: { choice: ChatChoice; options: readonly ConsultOption[]; kakaoUrl: string | null }) {
  const [app, setApp] = useState<Application>({});
  // PM 11/24 B: 상담 응답이 정책 검증 장애를 알리면 이 화면의 접수를 잠근다(새로고침 전까지). 실제 차단은 서버·DB가 따로 한다
  const [policyBlocked, setPolicyBlocked] = useState(false);
  // 필수 고지가 확정·버전 일치일 때만 접수 가능으로 안내한다(실제 접수는 서버 게이트가 다시 판정)
  const intakeOpen = noticeReadiness(REQUIRED_NOTICES, (process.env.NEXT_PUBLIC_PRIVACY_POLICY_VERSION ?? '').trim()).ready;
  return (
    <>
      <section className="section"><ConsultAiChat choice={choice} application={{ ...choice, ...app }} intakeOpen={intakeOpen && !policyBlocked} onPolicyBlocked={() => setPolicyBlocked(true)} /></section>
      <section className="section" id="assistant"><ApplicationAssistant app={app} onChange={setApp} />
        <p className="muted" role="status" data-field="intake-state">{policyBlocked ? POLICY_UNVERIFIED_GUIDANCE : intakeOpen ? '접수: 아래에서 고지를 확인하고 동의하면 접수할 수 있습니다.' : '접수 대기: 필수 고지 문구가 확정되기 전에는 접수를 받지 않습니다.'}</p></section>
      <section className="section" id="apply" aria-label="가입 상담 신청">
        <ConsultForm options={options} kakaoUrl={kakaoUrl} choice={choice} app={app} blocked={policyBlocked} />
      </section>
    </>
  );
}
