// 카카오톡 상품 문의 링크 — 순수 판정 모듈 (PM 6938169689). **기본 꺼짐 준비 코드. 실제 주소·활성 스위치는 없다.**
//
// - 카카오톡은 사용자(딜러)가 운영하는 **상품 문의 창구**다. 총판의 정식 가입 접수처가 아니며, 공식 접수 등록부
//   (src/server/intake/officialIntakeConfig.ts)와 섞지 않는다.
// - 실제 값은 서버 전용 설정(src/server/inquiry/kakaoInquiryConfig.ts)에만 있다. 이 모듈은 주어진 설정만 판정한다.
//   요청·고객 입력·환경변수·키·DB·네트워크를 읽지 않는다.
// - 전역 외부 상담 gate(EXTERNAL_CONSULT_ENABLED)와 문의 스위치가 **모두 정확히 true**이고, URL·검수 근거가 유효할 때만 on이다.
// - URL: 기존 https 고정 주소 검증(validateOfficialIntakeUrl)을 그대로 쓰고, 호스트는 pf.kakao.com 정확 일치만 허용한다.
//   경로 정규식은 **가짜 시험용 보수적 임시 제약**이다. 실제 카카오 경로 형식을 검증한 것이 아니며, 공개 링크를 받은 뒤 따로 대조한다.
//   오픈채팅(open.kakao.com)·개인 프로필·다른 호스트는 제외한다.
// - reviewRef 형식 검사는 실제 승인의 진위 확인을 대신하지 않는다. 실제 활성 변경은 별도 PM 검수 근거가 필요하다.
import { validateOfficialIntakeUrl } from './officialIntake';

export const KAKAO_INQUIRY_HOST = 'pf.kakao.com';
/** 가짜 시험용 임시 제약(실제 형식 미검증) */
const PROVISIONAL_PATH = /^\/_[A-Za-z0-9]{1,32}(?:\/chat)?$/;

// 표시 문구는 브라우저 코드(ConsultForm)도 쓰므로 판정 로직 없이 channels.ts에 둔다
export { KAKAO_INQUIRY_LABEL, KAKAO_INQUIRY_NOTES } from './channels';

export type KakaoInquiryResult =
  | { readonly state: 'on'; readonly href: string; readonly host: string }
  | { readonly state: 'off'; readonly reason: 'DISABLED' | 'NOT_SET' | 'INVALID' };

const OFF = (reason: 'DISABLED' | 'NOT_SET' | 'INVALID'): KakaoInquiryResult => Object.freeze({ state: 'off', reason });

/** 서버 설정만으로 판정한다. 추가 필드는 읽지 않는다. */
export function resolveKakaoInquiry(input: { globalGate: unknown; enabled: unknown; url: unknown; reviewRef: unknown }): KakaoInquiryResult {
  if (input.globalGate !== true || input.enabled !== true) return OFF('DISABLED');
  if (input.url === null || input.url === undefined || input.reviewRef === null || input.reviewRef === undefined) return OFF('NOT_SET');
  if (typeof input.reviewRef !== 'string' || !/^PM-[0-9]{6,12}$/.test(input.reviewRef)) return OFF('INVALID');
  const c = validateOfficialIntakeUrl(input.url);
  if (!c.ok) return OFF('INVALID');
  if (c.host !== KAKAO_INQUIRY_HOST) return OFF('INVALID');
  if (!PROVISIONAL_PATH.test(new URL(c.href).pathname)) return OFF('INVALID');
  return Object.freeze({ state: 'on', href: c.href, host: c.host });
}
