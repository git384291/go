// 관리자 화면 미리보기용 가상 데이터. 실제 고객정보 아님(이름은 '테스트' 고정, 번호 뒷자리는 일련번호).
export type MockLead = {
  id: string;
  createdAt: string;
  nameMasked: string;
  phoneMasked: string;
  interest: string;
  contactTime: string;
  status: 'new' | 'contacting' | 'consulted' | 'no_answer' | 'declined' | 'converted';
  assignee: string;
  /** 배정 직원 ID(가상). db/seed/test_seed.sql의 가상 직원과 같은 값. 미배정이면 null */
  assigneeId: string | null;
  source: string;
  notes: { at: string; by: string; body: string }[];
};

// 가상 직원 ID(시드와 동일, 실제 계정 아님)
export const MOCK_OWNER_ID = '00000000-0000-4000-8000-000000000001';
export const MOCK_COUNSELOR_ID = '00000000-0000-4000-8000-000000000002';

export const MOCK_LEADS: MockLead[] = [
  { id: 'mock-0007', createdAt: '11.13 20:41', nameMasked: '테*트', phoneMasked: '010-****-0007', interest: '인터넷 + TV', contactTime: '평일 저녁', status: 'new', assignee: '미배정', assigneeId: null, source: 'naver', notes: [] },
  { id: 'mock-0006', createdAt: '11.13 18:12', nameMasked: '테*트', phoneMasked: '010-****-0006', interest: 'CCTV · 보안', contactTime: '오전 10시 이후', status: 'contacting', assignee: '상담원A', assigneeId: MOCK_COUNSELOR_ID, source: 'kakao', notes: [{ at: '11.13 18:30', by: '상담원A', body: '매장 카메라 4대 희망, 현장 구조 사진 요청함' }] },
  { id: 'mock-0005', createdAt: '11.13 15:03', nameMasked: '테**트', phoneMasked: '010-****-0005', interest: '인터넷 + 집전화', contactTime: '', status: 'no_answer', assignee: '상담원A', assigneeId: MOCK_COUNSELOR_ID, source: 'direct', notes: [{ at: '11.13 15:20', by: '상담원A', body: '1차 부재, 저녁 재연락' }] },
  { id: 'mock-0004', createdAt: '11.12 21:47', nameMasked: '테*트', phoneMasked: '010-****-0004', interest: '인터넷 + TV', contactTime: '주말', status: 'consulted', assignee: '대표', assigneeId: MOCK_OWNER_ID, source: 'naver', notes: [{ at: '11.13 11:02', by: '대표', body: '3사 비교 안내 완료, 가족과 상의 후 회신' }] },
  { id: 'mock-0003', createdAt: '11.12 13:18', nameMasked: '테*트', phoneMasked: '010-****-0003', interest: '인터넷만', contactTime: '', status: 'converted', assignee: '대표', assigneeId: MOCK_OWNER_ID, source: 'meta', notes: [{ at: '11.12 16:40', by: '대표', body: '가입 진행 희망, 총판 양식 작성 예정' }] },
  { id: 'mock-0002', createdAt: '11.11 09:55', nameMasked: '테*트', phoneMasked: '010-****-0002', interest: '인터넷 + TV', contactTime: '평일 낮', status: 'declined', assignee: '상담원A', assigneeId: MOCK_COUNSELOR_ID, source: 'naver', notes: [{ at: '11.11 10:30', by: '상담원A', body: '현재 약정 1년 남아 보류' }] },
];

export const STATUS_LABEL: Record<MockLead['status'], string> = {
  new: '신규',
  contacting: '연락중',
  consulted: '상담완료',
  no_answer: '부재',
  declined: '거절',
  converted: '접수전환',
};
