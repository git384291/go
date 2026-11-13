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

t0=$(date +%s.%N)
pg_dump -h /tmp -p "$PORT" -U postgres -d "$SRC" --format=custom --no-owner --no-privileges \
  --schema=core --schema=pii --schema=security --schema=api --schema=extensions \
  --exclude-table-data=security.server_keys \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "pass:$DRILL_PASS" -out "$OUT/drill.dump.enc"
sha256sum "$OUT/drill.dump.enc" > "$OUT/drill.dump.enc.sha256"
t1=$(date +%s.%N)

# 복원: 새 DB → 복호화 → pg_restore(단일 트랜잭션) → 권한 스크립트 재적용
"${PSQL[@]}" -d postgres -c "drop database if exists $DST" -c "create database $DST" >/dev/null
sha256sum -c "$OUT/drill.dump.enc.sha256" >/dev/null
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$DRILL_PASS" -in "$OUT/drill.dump.enc" \
  | pg_restore -h /tmp -p "$PORT" -U postgres -d "$DST" --single-transaction --exit-on-error --no-owner
"${PSQL[@]}" -d "$DST" -f db/migrations/zz_grants.sql >/dev/null
t2=$(date +%s.%N)

fingerprint "$DST" > "$OUT/after.tsv"

# 복원 DB에서도 권한 검사 통과해야 한다
"${PSQL[@]}" -d "$DST" -f db/tests/00_helpers.sql >/dev/null
"${PSQL[@]}" -d "$DST" -f db/tests/10_grants.sql > /dev/null 2> "$OUT/grants-after-restore.log"
# 운영 배포 전에 쓰는 것과 같은 점검을 같은 읽기 전용 계정으로 실행
bash scripts/db-audit.sh "postgresql:///$DST?host=/tmp&port=$PORT&user=release_auditor" > "$OUT/audit-after-restore.log"

# 잘못된 키로는 복호화되지 않아야 한다
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:wrong" -in "$OUT/drill.dump.enc" -out /dev/null 2>/dev/null; then
  echo "FAIL | 잘못된 키로 복호화됨"; exit 1
fi

if diff -u "$OUT/before.tsv" "$OUT/after.tsv"; then
  printf 'PASS | 덤프·암호화 %.1f초, 복원·권한 재적용 %.1f초, 테이블 %s개 행 수·내용 해시 일치, 복원 DB 권한 검사 %s건 통과, 점검 계정 권한 점검 위반 0건, 잘못된 키 복호화 거부\n' \
    "$(echo "$t1 - $t0" | bc)" "$(echo "$t2 - $t1" | bc)" "$(wc -l < "$OUT/before.tsv")" \
    "$(grep -c 'PASS |' "$OUT/grants-after-restore.log")" | tee "$OUT/result.txt"
else
  echo "FAIL | 복원 전후 불일치"; exit 1
fi
cat "$OUT/after.tsv"
rm -f "$OUT/drill.dump.enc"   # 훈련 산출물(가상 데이터) 정리
