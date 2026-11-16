-- 목록 어댑터 PG 통합 시험 전용 가상 fixture(폐기용 DB에만 적용). 실제 고객정보·실제 키 없음.
-- 기존 db/seed/test_seed.sql은 바꾸지 않고 쓰지도 않는다(공유 DB·감사 건수 경쟁 방지).
\set ON_ERROR_STOP 1
begin;

-- 가상 서명 키(운영 키와 무관한 고정값)
insert into security.server_keys (key_id, purpose, secret) values
  (1, 'staff', decode(repeat('11', 32), 'hex')),
  (1, 'lead',  decode(repeat('22', 32), 'hex'));

insert into core.staff (user_id, role, active) values
  ('a0000000-0000-4000-8000-000000000001', 'owner',         true),
  ('a0000000-0000-4000-8000-000000000002', 'counselor',     true),
  ('a0000000-0000-4000-8000-000000000003', 'counselor',     true),
  ('a0000000-0000-4000-8000-000000000004', 'reviewer',      true),
  ('a0000000-0000-4000-8000-000000000005', 'policy_editor', true),
  ('a0000000-0000-4000-8000-000000000006', 'owner',         false);

insert into security.staff_sessions (id, user_id, created_at, revoked_at) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', now(), null),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', now(), null),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', now(), null),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004', now(), null),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000005', now(), null),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000006', now(), null),
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', now() - interval '13 hours', null),
  ('b0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', now(), now());

-- 가상 고객(암호문 형식만 맞춘 표식 값: 어댑터 응답에 나오면 안 된다)
insert into pii.customers (id, name_enc, phone_enc, phone_hmac, address_enc, retention_until) values
  ('c0000000-0000-4000-8000-000000000001', 'v1:LRS-SECRET-NAME', 'v1:LRS-SECRET-PHONE', repeat('d', 64), 'v1:LRS-SECRET-ADDR', now() + interval '90 days'),
  ('c0000000-0000-4000-8000-000000000002', 'v1:LRS-SECRET-NAME', 'v1:LRS-SECRET-PHONE', repeat('e', 64), null, now() + interval '90 days'),
  ('c0000000-0000-4000-8000-000000000003', 'v1:LRS-SECRET-NAME', 'v1:LRS-SECRET-PHONE', repeat('f', 64), null, now() + interval '90 days');

-- 인터넷+TV 리드 3건: 상담원 A 배정 / 상담원 B 배정 / 미배정. 자유 입력 열에는 표식 값(응답에 나오면 안 됨)
insert into core.leads (id, customer_id, name_masked, phone_last4, interest, contact_time, utm_source, status, assigned_to, idempotency_key, created_at) values
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', '홍*동', '1001', 'internet_tv', 'LRS-FREE-CONTACT', 'LRS-FREE-UTM', 'new',
   'a0000000-0000-4000-8000-000000000002', 'lrs-idempotency-0001', '2026-11-16 09:00:01+09'),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', '김*', '1002', 'internet_tv', 'LRS-FREE-CONTACT', 'LRS-FREE-UTM', 'contacting',
   'a0000000-0000-4000-8000-000000000003', 'lrs-idempotency-0002', '2026-11-16 09:00:02+09'),
  ('d0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', '남**수', '1003', 'internet_tv', null, null, 'new',
   null, 'lrs-idempotency-0003', '2026-11-16 09:00:03+09');

commit;
