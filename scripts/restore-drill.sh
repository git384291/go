#!/usr/bin/env bash
# 복구 훈련(가상 데이터 전용). REV-004 SEC-05: 자체 증분 복구는 운영에 쓰지 않고, 전체 덤프 복원 절차만 훈련한다.
# 순서: 가상 DB 준비 → 암호화 덤프 → 원본 삭제 가정 → 새 DB로 복원 → 행 수·내용 해시·권한 검사 비교 → 소요 시간 기록
# 사용: bash scripts/restore-drill.sh   (scripts/db-test.sh를 먼저 한 번 실행해 로컬 클러스터가 있어야 한다)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PGPORT_TEST:-54329}"
SRC=fideon_test
DST=fideon_restore
OUT=test-results/restore
mkdir -p "$OUT"
PSQL=(psql -X -q -h /tmp -p "$PORT" -U postgres -v ON_ERROR_STOP=1)

# ---- macOS(BSD 도구·Homebrew PostgreSQL)와 Linux(GitHub Actions) 공통 처리 ----
# 덤프·복원 도구는 시험 서버와 같은 PostgreSQL 설치본을 쓴다(db-test.sh와 같은 탐색 규칙). 버전이 어긋나면 덤프가 실패한다.
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin 2>/dev/null | sort -V | tail -1 || true)}"
[ -n "$PG_BIN" ] || PG_BIN=$(dirname "$(command -v pg_dump)")
sha256_file() { # sha256sum(Linux) 또는 shasum -a 256(macOS)
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
# macOS 기본 openssl(LibreSSL)도 -pbkdf2/-iter를 지원해야 한다. 지원하지 않으면 원인을 분명히 남기고 멈춘다
printf 'probe' | openssl enc -aes-256-cbc -pbkdf2 -iter 1000 -salt -pass pass:probe >/dev/null 2>&1 \
  || { echo "FAIL | 이 openssl은 enc -pbkdf2 -iter를 지원하지 않음: $(openssl version) (macOS: brew install openssl@3 후 PATH 앞에 추가)"; exit 1; }

# 훈련용 암호화 비밀번호(가상). 운영에서는 오프라인 보관 키를 쓴다.
DRILL_PASS="drill-only-$(date +%s)"

fingerprint() { # 테이블별 행 수와 내용 해시
  "${PSQL[@]}" -d "$1" -At -F $'\t' -c "
    select t, n, md5(coalesce(h, '')) from (
      select 'core.leads' t, count(*) n, string_agg(l::text, '|' order by l.id) h from core.leads l
      union all select 'core.lead_status_history', count(*), string_agg(x::text, '|' order by x.id) from core.lead_status_history x
      union all select 'core.lead_notes', count(*), string_agg(x::text, '|' order by x.id) from core.lead_notes x
      union all select 'core.audit_logs', count(*), string_agg(x::text, '|' order by x.id) from core.audit_logs x
      union all select 'core.staff', count(*), string_agg(x::text, '|' order by x.user_id) from core.staff x
      union all select 'pii.customers', count(*), string_agg(x::text, '|' order by x.id) from pii.customers x
      union all select 'pii.consents', count(*), string_agg(x::text, '|' order by x.id) from pii.consents x
      union all select 'pii.marketing_consents', count(*), string_agg(x::text, '|' order by x.id) from pii.marketing_consents x
      union all select 'security.staff_sessions', count(*), string_agg(x::text, '|' order by x.id) from security.staff_sessions x
    ) s order by t"
}

fingerprint "$SRC" > "$OUT/before.tsv"

acl_fingerprint() { # 권한 상태 지문: 스키마·테이블·시퀀스·함수의 소유자와 권한(aclexplode로 정규화), RLS·SECURITY DEFINER·STABLE 등
  "${PSQL[@]}" -d "$1" -At -F $'\t' -c "
    with nsp as (select oid, nspname from pg_namespace where nspname in ('core', 'pii', 'security', 'api', 'extensions'))
    select 'schema', n.nspname, '', pg_get_userbyid(n2.nspowner), coalesce((
      select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ',' order by pg_get_userbyid(a.grantee), a.privilege_type)
      from aclexplode(n2.nspacl) a), '-')
    from nsp n join pg_namespace n2 on n2.oid = n.oid
    union all
    select 'rel:' || c.relkind::text, n.nspname || '.' || c.relname,
           'rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity, pg_get_userbyid(c.relowner), coalesce((
      select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ',' order by pg_get_userbyid(a.grantee), a.privilege_type)
      from aclexplode(c.relacl) a), '-')
    from pg_class c join nsp n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'S', 'v', 'm')
    union all
    select 'func', n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
           'definer=' || p.prosecdef || ' volatile=' || p.provolatile::text || ' config=' || coalesce(array_to_string(p.proconfig, ';'), ''),
           pg_get_userbyid(p.proowner), coalesce((
      select string_agg(case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type, ','
             order by case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, a.privilege_type)
      from aclexplode(p.proacl) a), '(default:PUBLIC:EXECUTE)')
    from pg_proc p join nsp n on n.oid = p.pronamespace
    order by 1, 2"
}
acl_fingerprint "$SRC" > "$OUT/acl-before.tsv"

t0=$(date +%s)   # BSD date는 %N(나노초)을 지원하지 않으므로 초 단위로 잰다
# --schema 필터를 쓰면 확장(CREATE EXTENSION)은 덤프되지 않는다 → --extension=pgcrypto로 명시(PostgreSQL 14+).
# pgcrypto가 없으면 복원 DB에서 security.verify_token·core.product_approval_guard(서명 검증·승인 지문)가 동작하지 않는다.
"$PG_BIN/pg_dump" -h /tmp -p "$PORT" -U postgres -d "$SRC" --format=custom --no-owner --no-privileges \
  --schema=core --schema=pii --schema=security --schema=api --schema=extensions \
  --extension=pgcrypto \
  --exclude-table-data=security.server_keys \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "pass:$DRILL_PASS" -out "$OUT/drill.dump.enc"
sha256_file "$OUT/drill.dump.enc" > "$OUT/drill.dump.enc.sha256"
t1=$(date +%s)

# 복원: 새 DB → 복호화 → pg_restore(단일 트랜잭션) → 권한 스크립트 재적용
"${PSQL[@]}" -d postgres -c "drop database if exists $DST" -c "create database $DST" >/dev/null
[ "$(sha256_file "$OUT/drill.dump.enc")" = "$(cat "$OUT/drill.dump.enc.sha256")" ] || { echo "FAIL | 덤프 파일 해시 불일치"; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$DRILL_PASS" -in "$OUT/drill.dump.enc" \
  | "$PG_BIN/pg_restore" -h /tmp -p "$PORT" -U postgres -d "$DST" --single-transaction --exit-on-error --no-owner
"${PSQL[@]}" -d "$DST" -f db/migrations/zz_grants.sql >/dev/null
t2=$(date +%s)

fingerprint "$DST" > "$OUT/after.tsv"
acl_fingerprint "$DST" > "$OUT/acl-after.tsv"

# 회귀 검사 1: 복구 후 권한 상태가 원본과 완전히 같아야 한다.
#   어떤 마이그레이션이 zz_grants.sql에 없는 권한을 새로 만들면(이번 0006 사례) 여기서 바로 드러난다.
if ! diff -u "$OUT/acl-before.tsv" "$OUT/acl-after.tsv" > "$OUT/acl-diff.txt"; then
  echo "FAIL | 복구 후 권한 상태가 원본과 다름(마이그레이션에만 있고 zz_grants.sql에 없는 권한 가능성):"; cat "$OUT/acl-diff.txt"; exit 1
fi
# 회귀 검사 2: 점검 계정은 점검 함수 1개와 api USAGE만 갖고, 상품·리드 테이블과 다른 함수는 쓸 수 없어야 한다
AUD=$("${PSQL[@]}" -d "$DST" -At -c "
  select concat_ws(' ',
    has_schema_privilege('release_auditor', 'api', 'USAGE'),
    has_function_privilege('release_auditor', 'api.release_probe_product_scope()', 'EXECUTE'),
    has_schema_privilege('release_auditor', 'core', 'USAGE'),
    has_table_privilege('release_auditor', 'core.product_catalog', 'SELECT'),
    has_table_privilege('release_auditor', 'core.leads', 'SELECT'),
    has_function_privilege('release_auditor', 'api.create_lead(text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text)', 'EXECUTE'),
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('core', 'pii', 'security', 'api') and has_function_privilege('release_auditor', p.oid, 'EXECUTE')))")
[ "$AUD" = "t t f f f f 1" ] \
  || { echo "FAIL | 복구 후 점검 계정 권한이 기대와 다름 (api사용 점검함수 core사용 상품표 리드표 신청함수 실행가능함수수): $AUD"; exit 1; }

# 복원 DB에서도 권한 검사 통과해야 한다
"${PSQL[@]}" -d "$DST" -f db/tests/00_helpers.sql >/dev/null
"${PSQL[@]}" -d "$DST" -f db/tests/10_grants.sql > /dev/null 2> "$OUT/grants-after-restore.log"
# 운영 배포 전에 쓰는 것과 같은 점검을 같은 읽기 전용 계정으로 실행
bash scripts/db-audit.sh "postgresql:///$DST?host=/tmp&port=$PORT&user=release_auditor" > "$OUT/audit-after-restore.log"

# 잘못된 키로는 덤프를 되살릴 수 없어야 한다.
# AES-CBC는 틀린 키로도 약 1/256 확률로 패딩 검사를 우연히 통과해 openssl이 '성공'을 돌려준다(우연 실패 원인).
# 그래서 종료 코드 대신 결과물을 본다: 맞는 키 결과는 pg_dump 머리글(PGDMP)로 시작하고, 틀린 키 결과는 절대 그렇지 않아야 한다.
dump_magic() { { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$1" -in "$OUT/drill.dump.enc" 2>/dev/null || true; } | head -c 5 | od -An -c | tr -d ' \n'; }
[ "$(dump_magic "$DRILL_PASS")" = "PGDMP" ] || { echo "FAIL | 맞는 키 복호화 결과가 pg_dump 형식이 아님(대조 실패)"; exit 1; }
if [ "$(dump_magic wrong)" = "PGDMP" ]; then
  echo "FAIL | 잘못된 키로 덤프가 복원 가능한 형태로 복호화됨"; exit 1
fi

if diff -u "$OUT/before.tsv" "$OUT/after.tsv"; then
  printf 'PASS | 덤프·암호화 %s초, 복원·권한 재적용 %s초, 테이블 %s개 행 수·내용 해시 일치, 권한 상태(%s개 객체) 원본과 일치, 복원 DB 권한 검사 %s건 통과, 점검 계정 권한 점검 위반 0건, 잘못된 키 복호화 거부\n' \
    "$((t1 - t0))" "$((t2 - t1))" "$(wc -l < "$OUT/before.tsv" | tr -d ' ')" \
    "$(wc -l < "$OUT/acl-after.tsv" | tr -d ' ')" "$(grep -c 'PASS |' "$OUT/grants-after-restore.log")" | tee "$OUT/result.txt"
else
  echo "FAIL | 복원 전후 불일치"; exit 1
fi
cat "$OUT/after.tsv"
rm -f "$OUT/drill.dump.enc"   # 훈련 산출물(가상 데이터) 정리
