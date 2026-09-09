#!/usr/bin/env bash
# PROSM Time - security regression tests for the password reset path and
# the shared server-side rate limiter (Security Hardening phase).
#
# Runs the real hardening migration and the real assertions against a
# throwaway PostgreSQL database, so nothing here passes merely because
# the code or configuration exists.
#
# Usage:  PGHOST=... PGPORT=... PGUSER=... ./scripts/run-security-sql-tests.sh
set -euo pipefail

DB="${SECURITY_TEST_DB:-prosm_time_security_tests}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

echo "==> recreating $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB}" -c "create database ${DB}" >/dev/null

echo "==> loading fixture"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/security/fixture.sql" >/dev/null

echo "==> applying hardening migration"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260909130000_security_hardening_password_reset_and_public_endpoints.sql" >/dev/null

echo "==> running assertions"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/security/password_reset_and_rate_limit.test.sql" 2>&1 | sed 's/^psql[^ ]* //'

echo "==> loading license enforcement fixture"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/security/license_fixture.sql" >/dev/null

echo "==> applying license enforcement migration"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260909140000_prosm_time_installation_identity_and_license_enforcement.sql" >/dev/null

echo "==> running license enforcement assertions"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/security/license_enforcement.test.sql" 2>&1 | sed 's/^psql[^ ]* //'

echo "==> all security assertions passed"
