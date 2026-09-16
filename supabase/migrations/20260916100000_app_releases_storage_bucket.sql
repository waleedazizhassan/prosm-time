-- § user-directed, 2026-09-16: "لو ينفع ميتمش التحويل لصفحة جيتهاب
-- ويبقى التحميل ثابت من جوة السايت بتاعة بروسم" - avoid redirecting to
-- github.com; host the release download directly from a PROSM-owned
-- domain instead. A public, read-only Storage bucket serves this
-- exactly: release.yml uploads each build's artifacts here (in
-- addition to the existing GitHub Release, which stays the build/
-- distribution source of truth per that workflow's own top comment),
-- giving a stable *.supabase.co URL with zero github.com in it, that
-- prosm.net's own download button can point to directly.
begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('app-releases', 'app-releases', true, 209715200)
on conflict (id) do update set public = true, file_size_limit = 209715200;

-- Public read (anyone can download - this bucket exists specifically
-- to be a public download surface). Writes are service-role only
-- (CI's own SUPABASE_SERVICE_ROLE_KEY), never anon/authenticated.
create policy "anyone can read app-releases"
on storage.objects for select to anon, authenticated
using (bucket_id = 'app-releases');

commit;
