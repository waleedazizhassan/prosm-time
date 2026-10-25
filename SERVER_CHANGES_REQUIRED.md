# تغييرات السيرفر المطلوبة — PROSM Time v2.3.43

كل البنود ملفات migration في `supabase/migrations/` (تُطبَّق بالترتيب بـ `npx supabase db push --linked`)، ومختبرة على قاعدة PGlite من كل الـ migrations (`npm run test:db`). لا تعديل لأي migration مطبّقة سابقاً.

| Migration | الخطوة | المحتوى |
|---|---|---|
| `20261025100000_override_block_and_outside_zone_policy.sql` | 1 (بند 10) | صلاحية `attendance.override_block` (owner, manager)؛ `sites.outside_zone_policy` + trigger تزامن؛ `prosm_time_caller_can_override_block(site)`؛ `set_prosm_time_site_outside_zone_policy(site, policy)` (audit)؛ `clock_in_prosm_time_attendance` يتجاوز الحجب بالصلاحية ويسجّل `attendance.override_block` في `audit_logs`؛ `clock_out_prosm_time_attendance` لا يحجب خارج النطاق. |
