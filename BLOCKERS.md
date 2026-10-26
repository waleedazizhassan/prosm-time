# العوائق — PROSM Time v2.3.43

## B-01 — تطبيق الـ migrations على Supabase الحي مرفوض في هذه الجلسة — **اتحل 2026-10-25**
- **ما حصل:** `npx supabase db push --linked` اتمنع من مصنّف صلاحيات Claude Code (auto mode) — «Permission for this action was denied by the Claude Code auto mode classifier». الوصول نفسه شغال (`supabase migration list --linked` نجح والقاعدة متطابقة حتى `20261021130000`).
- **الدليل:** محاولة الخطوة 1، 2026-10-25؛ ومحاولة ثانية بعد موافقة المالك الصريحة («معاك كل الصلاحيات») اتمنعت برضه — المنع من الـ harness نفسه مش من نقص صلاحية Supabase.
- **البديل:** كل الـ migrations مكتوبة ومختبرة على قاعدة PGlite مبنية من كل الـ migrations (`npm run test:db`). لتطبيقها: المالك يشغّل `! npx supabase db push --linked` من الجلسة، أو يضيف صلاحية Bash لهذا الأمر. قائمة الـ migrations الجديدة في `SERVER_CHANGES_REQUIRED.md`.
- **الأثر:** الواجهة الجديدة تعتمد على أعمدة/دوال جديدة؛ **لا يتم نشر الويب/APK قبل تطبيقها** (قسم 8 بند 2).

- **الحل:** المالك شغّل `supabase db push --linked` من PowerShell وطبّق الـ 13 migration (20261025100000..220000)، وتأكدت بـ `migration list` إنها متطابقة. ونشرت `send-push` و`admin-clock-in` و`admin-clock-out` بنفسي (`functions deploy` اشتغل).

## B-02 — صفحة المنتج التسويقية خارج هذا المشروع (مفتوح، لا يمنع الإصدار)
- صفحة PROSM Time («Work. Tracked.»، أزرار Open Web App / Download / Try the free demo – 30 days) غير موجودة في هذا الريبو (البحث عن النصوص لم يجدها؛ الموجود فقط «Back to PROSM» في صفحات الدخول) — هي في موقع PROSM الرئيسي.
- **المطلوب يدوياً بعد الإصدار:** زر **Download** يشاور على `https://wcfdhsxzeryqwpmftgay.supabase.co/storage/v1/object/public/app-releases/PROSM-Time.apk` (الرابط الثابت، يتحدث تلقائياً مع كل إصدار) أو `.../PROSM-Time-v2.3.43.apk`؛ أي رقم إصدار مكتوب في الصفحة (عربي وإنجليزي) يصبح **2.3.43**؛ **Open Web App** = `https://time.prosm.net`؛ **Try the free demo – 30 days** = نفس التطبيق (`https://time.prosm.net`، بدء التجربة من صفحة الترحيب).
