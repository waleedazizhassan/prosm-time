# خطوات يدوية مطلوبة من وليد

## قيد التنفيذ

1. **Supabase PITR والنسخ الاحتياطي:** الخطة تشترط التأكد قبل تعديل الإنتاج. من Dashboard ← Database ← Backups تأكد من الخطة، وفعّل PITR (يتطلب Pro).
2. **اختبار R8 على موبايل حقيقي:** R8 كان سبب انهيار حقيقي في 2026-09-11. مفعّل لنسخة Play فقط. ثبّت البناء من Internal testing وجرّب: الدخول، الحضور، الكاميرا، الإشعارات، الراديو.
3. **Google Cloud Console:** قيّد مفتاح `AIza` بالحزمة `net.prosm.time` وببصمتي SHA-1:
   - App signing: `70:BC:AE:56:AA:9E:79:88:45:67:E8:61:04:A6:FB:49:52:EF:34:CF`
   - Upload: من شهادة الرفع.
4. **نشر الدوال:** `npx supabase functions deploy <name> --project-ref wcfdhsxzeryqwpmftgay` عند تغيّر أي دالة (النشر من جلستي ممنوع بصلاحيات النظام).
