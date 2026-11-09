# Backup and restore — PROSM Time production

Project: `wcfdhsxzeryqwpmftgay` (eu-central-1, Postgres 17).

## What exists today (checked 2026-11-09 with `supabase backups list`)

| | State |
|---|---|
| WAL archiving (`walg_enabled`) | on |
| Point-in-time recovery (`pitr_enabled`) | **off** |
| Daily backups listed | **none listed** |

**Finding:** no restorable backup is visible for the production database. Daily backups are part
of Supabase's paid plans (Pro: 7 days; PITR is a paid add-on). This needs the owner's decision in
the Supabase dashboard (Organization → Billing, then Database → Backups). Until then, the manual
dump below is the only backup, and it must be run on a schedule by someone with the database
password.

Database backups never include **Storage files**. Buckets in production:

| Bucket | Public | Contents |
|---|---|---|
| `camera-evidence` | no | clock-in photos (kept per the retention setting) |
| `leave-documents` | no | leave attachments |
| `payroll-exports` | no | bulk payslip ZIPs (swept automatically) |
| `report-exports` | no | generated reports |
| `organization-logos` | yes | customer logos |
| `user-avatars` | yes | profile photos |
| `app-releases` | yes | desktop installers |

`payroll-exports` and `report-exports` can be rebuilt from the database; the others cannot.

## Manual backup (works on any plan)

```sh
# database: schema + data, roles separately
npx supabase db dump --linked -f backup/schema.sql
npx supabase db dump --linked --data-only -f backup/data.sql
npx supabase db dump --linked --role-only -f backup/roles.sql
```

Storage: copy each non-rebuildable bucket with the Storage API or `supabase storage cp -r
ss:///<bucket> ./backup/<bucket> --experimental`. Keep the files encrypted and outside the
repository: they contain personal data (see `DATA_MAP.md`).

Secrets are not in any dump: the vault secret `prosm_time_service_role_key` and the edge-function
secrets (Resend / Platform keys) must be set again after a restore into a new project.

## Restore

1. **Never restore over production to test.** Create a separate Supabase project (same region).
2. `psql "$NEW_DB_URL" -f backup/roles.sql -f backup/schema.sql -f backup/data.sql`
   (or, with daily backups enabled, the dashboard's Restore button, which replaces the whole database).
3. Copy the Storage buckets back.
4. Set the vault secret and the edge-function secrets; deploy the edge functions
   (`npx supabase functions deploy --project-ref <new>`).
5. Check: `select count(*) from organizations`, sign in with a test account, open the dashboard,
   one payslip PDF, one camera photo. Check that the cron jobs exist (`select jobname from cron.job`).

## Restore test

Not run yet: it needs the separate project in step 1, which is a billing decision for the owner.
Once it exists, run the steps above and record the date, the dump size and the time each step took
here.
