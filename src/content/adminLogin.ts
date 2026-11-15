// 관리자 로그인 화면 상태·문구. 브라우저 코드에서도 쓰므로 서버 모듈을 import하지 않는다.
export type LoginError = 'INVALID_CREDENTIALS' | 'INVALID_CODE' | 'SESSION_EXPIRED' | 'ACCESS_DENIED' | 'UNAVAILABLE';
export type LoginState =
  | { step: 'password'; error?: LoginError }
  | { step: 'totp'; error?: LoginError }
  | { step: 'done'; role: string };

// 계정 존재 여부·비밀번호 정답 여부를 드러내지 않는 문구만 쓴다.
export const LOGIN_MESSAGES: Record<LoginError, string> = {
  INVALID_CREDENTIALS: '이메일 또는 비밀번호를 확인해 주세요.',
  INVALID_CODE: '인증 코드를 확인해 주세요.',
  SESSION_EXPIRED: '처음부터 다시 로그인해 주세요.',
  ACCESS_DENIED: '관리자 화면에 접근할 수 없습니다.',
  UNAVAILABLE: '잠시 후 다시 시도해 주세요.',
};
