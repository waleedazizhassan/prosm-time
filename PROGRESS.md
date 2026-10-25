# PROSM Time v2.3.43 — سجل التقدم

المرجع: `PROSM-Time-Prompt-Full-Updated.md` (26 بند + تدقيق + إصدار). الحالة: لم تبدأ / جارية / تمت / محجوبة.
أوامر البوابة لكل خطوة: `npm run lint` · `npm run check:i18n` · `npm test` · `npm run test:db` (أو الملف المعني) · `npm run build` (`tsc -b && vite build`، وفحص الأنواع الفعلي `npx tsc --noEmit -p tsconfig.app.json`).

| الخطوة | البند | الحالة | commit | ملاحظة |
|---|---|---|---|---|
| 1 | 10 تجاوز المدير + سياسة خارج النطاق | تمت (محلياً) | انظر git log | migration لم تُطبَّق على السيرفر — BLOCKERS B-01 |
| 2 | 11 الجلسات المفتوحة | لم تبدأ | | |
| 3 | 7/8 التقويم والعطلات | لم تبدأ | | |
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
