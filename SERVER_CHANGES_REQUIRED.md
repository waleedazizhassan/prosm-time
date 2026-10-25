# تغييرات السيرفر المطلوبة — PROSM Time v2.3.43

كل البنود ملفات migration في `supabase/migrations/` (تُطبَّق بالترتيب بـ `npx supabase db push --linked`)، ومختبرة على قاعدة PGlite من كل الـ migrations (`npm run test:db`). لا تعديل لأي migration مطبّقة سابقاً.

| Migration | الخطوة | المحتوى |
|---|---|---|
| `20261025100000_override_block_and_outside_zone_policy.sql` | 1 (بند 10) | صلاحية `attendance.override_block` (owner, manager)؛ `sites.outside_zone_policy` + trigger تزامن؛ `prosm_time_caller_can_override_block(site)`؛ `set_prosm_time_site_outside_zone_policy(site, policy)` (audit)؛ `clock_in_prosm_time_attendance` يتجاوز الحجب بالصلاحية ويسجّل `attendance.override_block` في `audit_logs`؛ `clock_out_prosm_time_attendance` لا يحجب خارج النطاق. |
| `20261025110000_open_session_policy.sql` | 2 (بند 11) | إعدادات الجلسة المفتوحة؛ أعمدة الجلسة؛ cron `prosm-time-open-sessions` كل 15 دقيقة (ويلغي `prosm-time-missing-clockout-check`)؛ صلاحيات `sessions.review_pending`, `settings.session_policy`؛ RPCs المراجعة/التمديد/القوائم/السياسة/تجاهل الأوفلاين؛ استبعاد المعلّق من الكشف والداشبورد وتقرير المواقع والبدلات؛ حذف إشعارات «لم يسجل الانصراف» المكررة. |
| `20261025120000_work_calendar.sql` | 3 (بند 7/8) | `public_holidays`, `schedule_exceptions` (+RLS)؛ `rest_days` للمنظمة/الموقع/الوردية، `week_start_day`, `timezone`؛ صلاحية `calendar.manage`؛ دوال نوع اليوم والاستثناء ويوم العمل؛ CRUD مدقق؛ `get_prosm_time_calendar`؛ `generate_prosm_time_timesheet` يقرأ التقويم. |
| `20261025130000_allowances_from_minutes.sql` | 4 (بند 6) | `overtime_minutes`, `worked_minutes`, `day_type`؛ `allowance_basis` + `set_prosm_time_allowance_basis`؛ حقائق اليوم وإعادة الحساب؛ `upsert`/`start_day`/`fill`/trigger التعبئة؛ إعادة حساب السجلات غير المعتمدة. |
| `20261025140000_allowance_review_edits.sql` | 5 (بند 21) | صلاحيات `allowances.edit_during_review`/`allowances.reopen_approved`؛ `manual_overrides`؛ `allowance_entry_adjustments`؛ trigger إجمالي الشيت؛ `adjust_prosm_time_allowance_entry`؛ `reopen_prosm_time_allowance_sheet`. |

## Edge Functions تحتاج إعادة نشر
- `send-push` (الخطوة 2): نصوص الإشعارين الجديدين (`_shared/pushTexts.ts`, `_shared/localizePush.ts`) وحقل `kind` في بيانات الإشعار — `npx supabase functions deploy send-push`.
