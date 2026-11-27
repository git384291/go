import 'server-only';
// 카카오톡 상품 문의 — 서버 전용 설정 (PM 6938169689). 현재: 꺼짐·주소 없음·검수 근거 없음.
// - 코드 상수다. 환경변수·URL query·고객 입력으로 켜거나 목적지를 바꿀 수 없다(기존 NEXT_PUBLIC_KAKAO_CHANNEL_URL 읽기는 제거).
// - 전역 gate(EXTERNAL_CONSULT_ENABLED, 현재 false)와 이 스위치가 모두 true여야 켜진다.
// - 켜려면 실제 공개 채널 주소·운영자 표시·개인정보 처리 조건을 확인하고, 별도 커밋으로 PM 검수를 받아야 한다.
//   이 준비 코드는 외부 상담·고객정보 수집 승인이 아니다.
import { EXTERNAL_CONSULT_ENABLED } from '@/content/channels';
import { resolveKakaoInquiry, type KakaoInquiryResult } from '@/content/kakaoInquiry';

export const KAKAO_INQUIRY_ENABLED: boolean = false;
export const KAKAO_INQUIRY_URL: string | null = null;
export const KAKAO_INQUIRY_REVIEW_REF: string | null = null;

/** 화면용 판정. 인자·요청·환경값을 받지 않는다. */
export function kakaoInquiryLink(): KakaoInquiryResult {
  return resolveKakaoInquiry({
    globalGate: EXTERNAL_CONSULT_ENABLED,
    enabled: KAKAO_INQUIRY_ENABLED,
    url: KAKAO_INQUIRY_URL,
    reviewRef: KAKAO_INQUIRY_REVIEW_REF,
  });
}
