-- 가상 데이터 전용 시드 (로컬·CI 테스트 DB). 실제 고객정보 없음.
\set ON_ERROR_STOP 1
begin;

-- 테스트 서명 키 (운영 키와 무관한 고정값)
insert into security.server_keys (key_id, purpose, secret) values
  (1, 'staff', decode(repeat('11', 32), 'hex')),
  (1, 'lead',  decode(repeat('22', 32), 'hex'));

insert into core.staff (user_id, role, active) values
  ('00000000-0000-4000-8000-000000000001', 'owner',     true),
  ('00000000-0000-4000-8000-000000000002', 'counselor', true),
  ('00000000-0000-4000-8000-000000000003', 'owner',     false),
  ('00000000-0000-4000-8000-000000000004', 'counselor', true),
  ('00000000-0000-4000-8000-000000000005', 'reviewer',  true);

insert into security.staff_sessions (id, user_id, created_at, revoked_at) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', now(), null),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', now(), null),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', now(), null),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', now(), null),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000005', now(), null),
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', now() - interval '13 hours', null),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', now(), now());

insert into core.settings (key, value) values
  ('lead_retention_days', '90'),
  ('privacy_policy_version', '"privacy-test-v1"'),
  ('duplicate_window_days', '7');
update core.feature_flags set enabled = true where key = 'lead_form';

-- 가상 고객 3명 (암호문 형식만 맞춘 더미 값)
insert into pii.customers (id, name_enc, phone_enc, phone_hmac, retention_until) values
  ('20000000-0000-4000-8000-000000000001', 'v1:dummy', 'v1:dummy', repeat('a', 64), now() + interval '90 days'),
  ('20000000-0000-4000-8000-000000000002', 'v1:dummy', 'v1:dummy', repeat('b', 64), now() + interval '90 days'),
  ('20000000-0000-4000-8000-000000000003', 'v1:dummy', 'v1:dummy', repeat('c', 64), now() - interval '1 day');

insert into core.leads (id, customer_id, name_masked, phone_last4, interest, assigned_to, idempotency_key) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '테*고', '0001', 'internet_tv',
   '00000000-0000-4000-8000-000000000002', 'seed-idempotency-0001'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '테*고', '0002', 'internet_phone',
   '00000000-0000-4000-8000-000000000004', 'seed-idempotency-0002'),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', '테*고', '0003', 'cctv_security',
   null, 'seed-idempotency-0003');

commit;
