# PROSM Time v2.3.43 — سجل التقدم

المرجع: `PROSM-Time-Prompt-Full-Updated.md` (26 بند + تدقيق + إصدار). الحالة: لم تبدأ / جارية / تمت / محجوبة.
أوامر البوابة لكل خطوة: `npm run lint` · `npm run check:i18n` · `npm test` · `npm run test:db` (أو الملف المعني) · `npm run build` (`tsc -b && vite build`، وفحص الأنواع الفعلي `npx tsc --noEmit -p tsconfig.app.json`).

| الخطوة | البند | الحالة | commit | ملاحظة |
|---|---|---|---|---|
| 1 | 10 تجاوز المدير + سياسة خارج النطاق | تمت (محلياً) | انظر git log | migration لم تُطبَّق على السيرفر — BLOCKERS B-01 |
| 2 | 11 الجلسات المفتوحة | تمت (محلياً) | انظر git log | migration لم تُطبَّق — B-01؛ send-push يحتاج إعادة نشر |
| 3 | 7/8 التقويم والعطلات | تمت (محلياً) | انظر git log | migration لم تُطبَّق — B-01 |
| 4 | 6 البدلات بالزمن الفعلي | لم تبدأ | | |
| 5 | 21 تعديل البدلات أثناء المراجعة | لم تبدأ | | |
| 6 | 23 الإضافي والخصم والأذونات | لم تبدأ | | |
| 7 | 25 أنواع الإجازات | لم تبدأ | | |
| 8 | 20 منع إلغاء الإجازة المعتمدة | لم تبدأ | | |
| 9 | 19 خصم الإجازة بدون أجر | لم تبدأ | | |
| 10 | 9 التسجيل بالنيابة | لم تبدأ | | |
| 11 | 22 الصور الثابتة والحيوية | لم تبدأ | | |
| 12 | 24 الانصراف عند مغادرة النطاق | لم تبدأ | | |
| 13 | 15 ثم 14 دائرة النطاق وصفحة الموظف | لم تبدأ | | |
| 14 | 17 Avatar | لم تبدأ | | |
| 15 | 18 التجميع حسب الدور | لم تبدأ | | |
| 16 | 26 التخطيط المرن والقايمة الجانبية | لم تبدأ | | |
| 17 | 5/4 الداشبورد | لم تبدأ | | |
| 18 | 16 التصدير | لم تبدأ | | |
| 19 | 12/13/1 Android | لم تبدأ | | |
| 20 | 3 بانر الأوفلاين | لم تبدأ | | |
| 21 | التدقيق الشامل | لم تبدأ | | |
| 22 | الإصدار | لم تبدأ | | |

---

## الخطوة 1 — بند 10: تجاوز المدير/الأونر وسياسة خارج النطاق

**الخطة:**
1. الملفات: `clock_in_prosm_time_attendance` (آخر تعريف 20261018120000) و`clock_out_prosm_time_attendance` (20261013180000)، `SiteRepository.ts`، `SitePolicySettingsCard.tsx`، i18n `sites`/`people`.
2. صلاحية جديدة `attendance.override_block` في كتالوج `permissions` + `role_default_permissions` (owner, manager)؛ نطاقها: المواقع اللي يديرها (`current_prosm_time_managed_site_ids`) أو الأونر.
3. عمود `sites.outside_zone_policy` (`ALLOW_WITH_EXCEPTION` افتراضي | `BLOCK`) متزامن مع العمود القديم `block_self_clock_in_outside_geofence` بـ trigger.
4. الانصراف خارج النطاق لا يُحجب أبداً (استثناء geofence الموجود)، وتجاوز الحجب يتسجل في `audit_logs` كـ `attendance.override_block`.
5. Migration `20261025100000_override_block_and_outside_zone_policy.sql` + اختبار `supabase/tests/overrideBlock.test.ts`.

**التنفيذ:** تم كما في الخطة. الأونر يفضل ممنوع من الحضور الذاتي (قرار مالك سابق، DECISIONS D-01).

**الاختبارات (فعلية):**
- `npx vitest run --config vitest.db.config.ts supabase/tests/overrideBlock.test.ts` → 10/10 ناجح (موظف/مشرف/مدير/أونر × داخل/خارج/بعد السماح × دخول/انصراف، مدير موقع آخر، مشرف بصلاحية ممنوحة بدون إدارة الموقع، ضابط السياسة وتدقيقه).
- `npm run lint` نظيف · `npm run check:i18n` 1276 مفتاح في 5 لغات · `npm test` 85/85 · `npm run test:db` 41 ملف / 170 اختبار ناجح · `npm run build` ناجح.
- **لم يُختبر:** التطبيق على قاعدة Supabase الحية (`supabase db push` مرفوض من مصنّف الصلاحيات — B-01).

---

## الخطوة 2 — بند 11: الجلسات المفتوحة

**الخطة:**
1. إعدادات منظمة `open_session_alert_hours`(12) و`open_session_max_hours`(24) و`open_session_policy_since`؛ أعمدة جلسة: `long_session_alerted_at`, `still_working_at`, `last_activity_at`, `extended_until`, `auto_closed`, `hours_review_status` (none/pending/reviewed).
2. وظيفة cron كل 15 دقيقة `process_prosm_time_open_sessions` (بدل وظيفة الـ 6 ساعات اللي كانت بتكرر الإشعار): تنبيه مرة واحدة، إغلاق تلقائي عند آخر نشاط بساعات معلّقة + audit.
3. RPCs: `respond_prosm_time_long_session`, `touch_prosm_time_session_activity`, `extend_prosm_time_session`, `review_prosm_time_pending_session`, `list_prosm_time_pending_sessions`, `list_prosm_time_stale_open_sessions`, `set_prosm_time_session_policy`, `log_prosm_time_offline_discard`؛ صلاحيات `sessions.review_pending` و`settings.session_policy`.
4. استبعاد المعلّق والمفتوح من: `generate_prosm_time_timesheet`، `get_prosm_time_dashboard_summary`، `list_prosm_time_report_site_summary` (وإصلاح تكرار الساعات فيه)، وتعبئة البدلات التلقائية.
5. الواجهة: `LongSessionPrompt` في كارت الحضور، `PendingHoursCard` في لوحة المدير، `SessionPolicySettingsCard` في الإعدادات، تسجيل «تجاهل» الأوفلاين، ترجمة وتوجيه نوعي الإشعار الجديدين (الواجهة والـ push).

**اكتشافات أثناء التنفيذ:**
- `generate_prosm_time_timesheet` كان بيحسب الجلسة المفتوحة لحد `now()` — ده سبب الـ 100 ساعة أسبوعياً. اتصلح.
- `list_prosm_time_report_site_summary` كان بيضرب ساعات كل جلسة في عدد أحداثها (join مع events). اتصلح.
- وظيفة cron القديمة كانت بتبعت نفس الإشعار كل 6 ساعات لكل جلسة > 12 ساعة. اتشالت، والمكرر القديم اتمسح.

**الاختبارات (فعلية):** `supabase/tests/openSessions.test.ts` 10/10 (تنبيه مرة واحدة، «لسه شغال»، إغلاق عند آخر نشاط، استبعاد من الكشف، مراجعة بصلاحية ونطاق وسبب، التمديد، الجلسات القديمة تُعرض ولا تُغلق، الإعداد وتدقيقه، تسجيل التجاهل) · `freshDatabase` ناجح · `npm run lint` نظيف · `check:i18n` 1311 مفتاح · `npm test` 85/85 · `npm run build` ناجح.
**لم يُختبر:** الـ cron الفعلي على Supabase، الـ push الحقيقي على جهاز (يحتاج نشر `send-push`)، والتطبيق على القاعدة الحية (B-01).

---

## الخطوة 3 — بند 7 و8: تقويم العطلات والأيام الاستثنائية

**الخطة:**
1. جداول `public_holidays` (اسم، تاريخ/مدى ≤31 يوم، منظمة أو موقع، مدفوعة) و`schedule_exceptions` (تاريخ/مدى، نطاق منظمة/موقع/وردية جاهزة/شخص، مواعيد بديلة، يوم إجازة، «بدون خصم»، سبب إلزامي) مع RLS.
2. العطلات الأسبوعية: `organization_settings.rest_days` (الجمعة افتراضياً) + `week_start_day` (السبت) + `timezone` (Africa/Cairo)، و`sites.rest_days` و`shift_templates.rest_days` (null = يرث).
3. دوال: `prosm_time_day_type` (public_holiday/weekly_rest/workday)، `prosm_time_day_exception` (الأكثر تحديداً)، `prosm_time_work_date` (يوم العمل بتوقيت الموقع بدل UTC)؛ CRUD بصلاحية `calendar.manage` ونطاق المواقع + audit؛ `get_prosm_time_calendar`.
4. `generate_prosm_time_timesheet`: يوم العمل بتوقيت الموقع، الشغل في عطلة = كله إضافي بدون خصم تأخير، اليوم الاستثنائي يغيّر بداية التأخير/بداية الإضافي أو يلغي الخصم.
5. صفحة `/calendar` «التقويم والعطلات» في القايمة الجانبية (صلاحية `calendar.manage`).

**قرار:** الشغل في يوم عطلة يتحسب في الـ timesheet كله «إضافي» (القاعدة في البند)، والبدلات تسعّره «يوم إضافي» في الخطوة 4 — DECISIONS D-04.

**الاختبارات (فعلية):** `supabase/tests/workCalendar.test.ts` 7/7 (الافتراضيات، صلاحيات العطلات بالنطاق، أيام راحة الموقع، العطلة = إضافي بدون خصم، يوم عادي بتوقيت القاهرة، يوم استثنائي 4 العصر بدون خصم، التحقق والقراءة) + `openSessions` + `freshDatabase` (17 ناجح) · lint نظيف · i18n 1368 مفتاح · `npm test` 85/85 · build ناجح.
**لم يُختبر:** الصفحة في متصفح حقيقي (لا يوجد تشغيل مرئي في هذه البيئة).
