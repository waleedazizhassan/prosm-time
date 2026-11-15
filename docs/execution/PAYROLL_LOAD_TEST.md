# Payroll load test (spec 15.15)

Measured 2026-11-15 on PGlite (in-memory, single process - a real Postgres server is faster).
1000 employees x 30 components (30,000 lines); net checked: 9,500 per employee.

| Step | Time |
|---|---|
| setup: 1,000 employees | 1,610 ms |
| setup: 1,000 profiles x 30 components | 5,441 ms |
| create the cycle | 8,494 ms |
| recalculate | 8,476 ms |
| validate | 655 ms |
| submit | 611 ms |
| approve (snapshot) | 3,847 ms |
| summary report | 2,849 ms |
| start the bulk payslip export (1,000 serials) | 1,840 ms |

Run again: `npx vitest run --config vitest.db.config.ts supabase/tests/payrollLoad.test.ts`
