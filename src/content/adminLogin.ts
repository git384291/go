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

// 로그아웃 결과. 'complete'가 아니면 로그인 화면에 경고를 보여 준다(원문 오류는 싣지 않음).
export type LogoutOutcome = 'complete' | 'db_unconfirmed' | 'auth_unconfirmed' | 'both_unconfirmed' | 'local_not_cleared';

export const LOGOUT_MESSAGES: Record<Exclude<LogoutOutcome, 'complete'>, string> = {
  db_unconfirmed: '이 브라우저의 로그인은 종료했지만, 서버의 관리자 세션 종료는 확인하지 못했습니다. 세션은 최대 12시간 뒤 자동 만료됩니다. 공용 기기라면 대표에게 알려 주세요.',
  auth_unconfirmed: '관리자 세션은 종료했고 이 브라우저의 로그인 정보도 지웠습니다. 인증 서버의 로그아웃은 확인하지 못했습니다.',
  both_unconfirmed: '이 브라우저의 로그인 정보는 지웠지만, 서버 쪽 로그아웃을 확인하지 못했습니다. 세션은 최대 12시간 뒤 자동 만료됩니다. 공용 기기라면 대표에게 알려 주세요.',
  local_not_cleared: '로그아웃을 완료하지 못했습니다. 브라우저 창을 모두 닫고 다시 시도해 주세요.',
};

export function logoutNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOGOUT_MESSAGES, value)
    ? LOGOUT_MESSAGES[value as keyof typeof LOGOUT_MESSAGES]
    : null;
}
