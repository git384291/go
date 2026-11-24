# 통화 녹취·STT·AI 요약·고객 이력 (PM 11/25 ①~④)

상태: **Mock·가상 DB 시험만 완료. 실제 통신사·저장소·STT·AI 연결과 운영 활성화는 PM 승인 전 금지.**
기본값: 녹취·변환·요약 스위치 전부 OFF, STT 월 한도 0원, 단가 0원 → 외부 비용 0.

## 구성

| 단계 | DB | 서버 | 핵심 규칙 |
|---|---|---|---|
| ① 녹취·저장 | 0050 `api.call_ingest` 외 | `calls/ingest.ts`, `calls/recording.ts` | 안내 버전 일치 시에만 보관, AES-256-GCM 파일 암호화, 연락처는 HMAC만, (통신사, 통화ID) 유일, 열람은 대표·담당만·사유·감사·시간당 30회, 보존 기한·리드 파기 시 삭제 |
| ② STT | 0051 `api.call_stt_claim/complete`, `api.call_job_fail` | `calls/stt.ts` | 월 한도 안에서 비용 먼저 예약한 작업만 처리, 잠금 10분·최대 3회, 늦은 작업자 덮어쓰기 차단, 원문 암호화·가린 글만 평문 |
| ③ AI 요약 | 0052 `api.call_summary_*` | `calls/summary.ts` | 가린 변환문만 AI 입력, 근거 문장이 변환문에 없으면 unknown/null(DB도 거부), AI 1판 + 관리자 수정 판(추가 전용), AI 비용은 기존 AI 월 한도 원장 사용 |
| ④ 고객 이력 | 0053 `api.customer_timeline`, `api.timeline_by_date` | (화면 미연결) | 같은 연락처 리드 묶음, 상담원은 자기 담당 리드 기록만, 미연결 통화는 대표만, 원문·해시·경로 미노출 |

권한: 새 역할 `app_call`(작업자 함수 8개만, 테이블 권한 없음). 관리자 함수는 `app_staff`. `db/tests/10_grants.sql` 허용 목록에 반영.

## STT 업체 비교(공식 가격표 기준, 2026-11-25 확인)

| 업체 | 공식 단가 | 확인 내용 | 미확인 |
|---|---|---|---|
| Google Cloud STT V2 | 표준 $0.016/분(월 50만 분까지), 동적 배치 $0.003/분 | 표준 모델에 phone_call·chirp 포함 | 한국어 전화 음성 정확도 |
| Amazon Transcribe | 배치 예시 $0.006/분(구간 표기 없음), Call Analytics $0.03/분 | 무료 60분/월(12개월) | 1구간 표준 단가 표 미확인, 한국어 정확도 |
| OpenAI | whisper-1 $0.006/분(사용 중단 표시), gpt-4o-transcribe 오디오 입력 $2.50/백만 토큰(사용 중단 표시) | — | 분당 환산, 후속 모델 단가 |
| Azure Speech | 무료 5시간/월(실시간) | — | 유료 단가(페이지에 금액 표시 없음) |
| 네이버 CLOVA Speech | 사용 시간 과금 | 한국어 단문·장문·스트리밍 지원 | 금액, 8kHz 전화망·화자 분리 |
| 리턴제로(RTZR) | — | — | 공식 가격표 확인 못 함 |

**정확도:** 한국어 전화 통화 기준 공식 비교 수치는 확인하지 못했습니다. 추측으로 순위를 매기지 않습니다.
**권장(승인 필요):** 실제 녹취 대신 동의받은 시험 통화 20건(가상 대본)으로 후보 2~3곳의 글자 오류율(CER)과 실제 청구액을 비교. 비용 발생 → PM 승인 후 진행.

출처: [Google STT pricing](https://cloud.google.com/speech-to-text/pricing/), [Amazon Transcribe pricing](https://aws.amazon.com/transcribe/pricing/), [OpenAI whisper-1](https://developers.openai.com/api/docs/models/whisper-1), [OpenAI gpt-4o-transcribe](https://developers.openai.com/api/docs/models/gpt-4o-transcribe), [Azure Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/), [CLOVA Speech 사용 준비](https://guide.ncloud-docs.com/docs/ko/clovaspeech-spec)

## 운영 활성화 전 필요(PM 승인 항목)

1. 통신사(인터넷 전화) 업체 선정·웹훅 서명 검증 연결 — 미구현
2. 녹취 저장소(Supabase Storage 비공개 버킷) 연결 — 미구현(메모리 Mock만)
3. STT 업체 선정·실제 어댑터 — 미구현(`CALL_STT_MODE=live`는 거부)
4. 요약 AI 실제 모델 — 미구현(`CALL_SUMMARY_MODE=live`는 거부)
5. 녹취 안내 문구 확정·법률 검토 후 `call_settings_set`(대표, 사유)
6. 예약 작업: `core.purge_expired_calls()`(보존 만료), 저장소 삭제 대기열 처리
7. 관리자 화면(녹취 듣기·요약 수정·고객 타임라인) — 미구현(DB 함수만)
