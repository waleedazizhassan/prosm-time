# تغييرات السيرفر المطلوبة — PROSM Time v2.3.43

كل البنود ملفات migration في `supabase/migrations/` (تُطبَّق بالترتيب بـ `npx supabase db push --linked`)، ومختبرة على قاعدة PGlite من كل الـ migrations (`npm run test:db`). لا تعديل لأي migration مطبّقة سابقاً.

| Migration | الخطوة | المحتوى |
|---|---|---|
| `20261025100000_override_block_and_outside_zone_policy.sql` | 1 (بند 10) | صلاحية `attendance.override_block` (owner, manager)؛ `sites.outside_zone_policy` + trigger تزامن؛ `prosm_time_caller_can_override_block(site)`؛ `set_prosm_time_site_outside_zone_policy(site, policy)` (audit)؛ `clock_in_prosm_time_attendance` يتجاوز الحجب بالصلاحية ويسجّل `attendance.override_block` في `audit_logs`؛ `clock_out_prosm_time_attendance` لا يحجب خارج النطاق. |
| `20261025110000_open_session_policy.sql` | 2 (بند 11) | إعدادات الجلسة المفتوحة؛ أعمدة الجلسة؛ cron `prosm-time-open-sessions` كل 15 دقيقة (ويلغي `prosm-time-missing-clockout-check`)؛ صلاحيات `sessions.review_pending`, `settings.session_policy`؛ RPCs المراجعة/التمديد/القوائم/السياسة/تجاهل الأوفلاين؛ استبعاد المعلّق من الكشف والداشبورد وتقرير المواقع والبدلات؛ حذف إشعارات «لم يسجل الانصراف» المكررة. |
| `20261025120000_work_calendar.sql` | 3 (بند 7/8) | `public_holidays`, `schedule_exceptions` (+RLS)؛ `rest_days` للمنظمة/الموقع/الوردية، `week_start_day`, `timezone`؛ صلاحية `calendar.manage`؛ دوال نوع اليوم والاستثناء ويوم العمل؛ CRUD مدقق؛ `get_prosm_time_calendar`؛ `generate_prosm_time_timesheet` يقرأ التقويم. |
| `20261025130000_allowances_from_minutes.sql` | 4 (بند 6) | `overtime_minutes`, `worked_minutes`, `day_type`؛ `allowance_basis` + `set_prosm_time_allowance_basis`؛ حقائق اليوم وإعادة الحساب؛ `upsert`/`start_day`/`fill`/trigger التعبئة؛ إعادة حساب السجلات غير المعتمدة. |
| `20261025140000_allowance_review_edits.sql` | 5 (بند 21) | صلاحيات `allowances.edit_during_review`/`allowances.reopen_approved`؛ `manual_overrides`؛ `allowance_entry_adjustments`؛ trigger إجمالي الشيت؛ `adjust_prosm_time_allowance_entry`؛ `reopen_prosm_time_allowance_sheet`. |
| `20261025150000_overtime_permissions_control.sql` | 6 (بند 23) | صلاحية `attendance.manage_permissions`؛ `overtime_policies`, `attendance_permissions`, `attendance_day_adjustments` (+RLS)؛ قواعد استراحة الورديات؛ `prosm_time_day_summary`؛ RPCs الأذونات والتعديل والطابور والسياسة؛ الكشف والبدلات من المحرك؛ عدّاد الداشبورد؛ إعادة حساب غير المعتمد. |
| `20261025160000_leave_types.sql` | 7 (بند 25) | صلاحية `leave.manage_types`؛ `users.hire_date`/`special_needs_entitlement`؛ `leave_types` + زرع + trigger؛ bucket `leave-documents` + سياساته؛ قواعد الطلب والرصيد؛ إدارة الأنواع وبيانات التعيين. |
| `20261025170000_leave_cancel_before_start.sql` | 8 (بند 20) | `prosm_time_leave_started`, `prosm_time_after_leave_cancelled`؛ `cancel_prosm_time_leave_request` للمعتمدة قبل يومها؛ تعديل `review_prosm_time_leave`؛ `list_prosm_time_approved_leave_requests` + `can_cancel`. |
| `20261025180000_unpaid_leave_deduction.sql` | 9 (بند 19) | صلاحية `leave.set_deduction`؛ `unpaid_leave_divisor`؛ أعمدة الخصم؛ `payroll_adjustments` (+RLS)؛ الاقتراح والتسجيل والعكس والتعديل والقائمة؛ `review_prosm_time_leave` بمعامل الخصم (يحذف نسخة الـ 3 معاملات). |
| `20261025190000_on_behalf_time_and_place.sql` | 10 (بند 9) | `admin_clock_in/out_prosm_time_attendance` بوقت ومكان؛ `time_source` يقبل `admin_set`. |
| `20261025200000_capture_integrity.sql` | 11 (بند 22) | صلاحيتان؛ إعدادات الحيوية للموقع والاستثناء؛ أعمدة على `camera_evidence`؛ `capture_tokens`, `integrity_flags` (+RLS)؛ إصدار الرمز وتسجيل السلامة؛ trigger الإحداثيات؛ الإعدادات والمراجعة والقائمة؛ عدّاد الداشبورد. |

## Edge Functions تحتاج إعادة نشر
- `send-push` (الخطوتان 2 و6): نصوص الإشعارين الجديدين (`_shared/pushTexts.ts`, `_shared/localizePush.ts`) وحقل `kind` في بيانات الإشعار — `npx supabase functions deploy send-push`.
- `admin-clock-in`, `admin-clock-out` (الخطوة 10): تمرير `occurredAt` و`manualLocationLabel` — `npx supabase functions deploy admin-clock-in admin-clock-out`.
