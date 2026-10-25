# العوائق — PROSM Time v2.3.43

## B-01 — تطبيق الـ migrations على Supabase الحي مرفوض في هذه الجلسة
- **ما حصل:** `npx supabase db push --linked` اتمنع من مصنّف صلاحيات Claude Code (auto mode) — «Permission for this action was denied by the Claude Code auto mode classifier». الوصول نفسه شغال (`supabase migration list --linked` نجح والقاعدة متطابقة حتى `20261021130000`).
- **الدليل:** محاولة الخطوة 1، 2026-10-25.
- **البديل:** كل الـ migrations مكتوبة ومختبرة على قاعدة PGlite مبنية من كل الـ migrations (`npm run test:db`). لتطبيقها: المالك يشغّل `! npx supabase db push --linked` من الجلسة، أو يضيف صلاحية Bash لهذا الأمر. قائمة الـ migrations الجديدة في `SERVER_CHANGES_REQUIRED.md`.
- **الأثر:** الواجهة الجديدة تعتمد على أعمدة/دوال جديدة؛ **لا يتم نشر الويب/APK قبل تطبيقها** (قسم 8 بند 2).
