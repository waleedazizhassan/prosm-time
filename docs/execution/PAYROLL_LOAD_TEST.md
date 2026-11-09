# Payroll load test (spec 15.15)

Measured 2026-11-09 on PGlite (in-memory, single process - a real Postgres server is faster).
1000 employees x 30 components (30,000 lines); net checked: 9,500 per employee.

| Step | Time |
|---|---|
| setup: 1,000 employees | 436 ms |
| setup: 1,000 profiles x 30 components | 3,756 ms |
| create the cycle | 6,392 ms |
| recalculate | 6,009 ms |
| validate | 344 ms |
| submit | 309 ms |
| approve (snapshot) | 2,825 ms |
| summary report | 2,558 ms |
| start the bulk payslip export (1,000 serials) | 1,821 ms |

Run again: `npx vitest run --config vitest.db.config.ts supabase/tests/payrollLoad.test.ts`
