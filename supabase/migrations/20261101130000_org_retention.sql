-- 2026-11-01 (plan stage 7.1; Privacy Policy v2 section 8): an organisation may
-- shorten how long it keeps shift location points (30 days) and attendance
-- photos (90 days), never lengthen them, and every automatic deletion is logged.
-- Shortening applies to what is already stored too.
-- Rollback: drop the triggers, the two functions, data_deletion_log and both
-- columns, and restore the two purge functions from their earlier migrations.

begin;

alter table public.organization_settings
    add column location_retention_days integer not null default 30 check (location_retention_days between 1 and 30),
    add column photo_retention_days integer not null default 90 check (photo_retention_days between 1 and 90);

create table public.data_deletion_log (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid references public.organizations(id) on delete cascade,
    kind text not null check (kind in ('location_samples', 'camera_evidence')),
    deleted_count integer not null,
    deleted_at timestamptz not null default now()
);

alter table public.data_deletion_log enable row level security;
revoke all on public.data_deletion_log from anon, authenticated;
grant select on public.data_deletion_log to authenticated;

create policy "the owner sees the organisation's deletions" on public.data_deletion_log
for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

create or replace function public.prosm_time_apply_location_retention()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_days integer;
begin
    select s.location_retention_days into v_days
    from users u join organization_settings s on s.organization_id = u.organization_id
    where u.id = new.user_id;
    if v_days is not null then new.retention_expires_at := least(new.retention_expires_at, now() + make_interval(days => v_days)); end if;
    return new;
end;
$function$;
revoke all on function public.prosm_time_apply_location_retention() from public, anon, authenticated;

create trigger location_samples_retention
before insert on public.location_samples
for each row execute function public.prosm_time_apply_location_retention();

create or replace function public.prosm_time_apply_photo_retention()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_days integer;
begin
    select photo_retention_days into v_days from organization_settings where organization_id = new.organization_id;
    if v_days is not null then new.retention_expires_at := least(new.retention_expires_at, now() + make_interval(days => v_days)); end if;
    return new;
end;
$function$;
revoke all on function public.prosm_time_apply_photo_retention() from public, anon, authenticated;

create trigger camera_evidence_retention
before insert on public.camera_evidence
for each row execute function public.prosm_time_apply_photo_retention();

create or replace function public.set_prosm_time_retention(p_location_days integer, p_photo_days integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CHANGES THE RETENTION'; end if;
    if p_location_days not between 1 and 30 or p_photo_days not between 1 and 90 then raise exception 'INVALID RETENTION PERIOD'; end if;

    update organization_settings set location_retention_days = p_location_days, photo_retention_days = p_photo_days, updated_at = now()
    where organization_id = v_org;
    update location_samples set retention_expires_at = least(retention_expires_at, captured_at + make_interval(days => p_location_days))
    where user_id in (select id from users where organization_id = v_org);
    update camera_evidence set retention_expires_at = least(retention_expires_at, captured_at + make_interval(days => p_photo_days))
    where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'retention.changed', 'organization_settings', 'Retention periods changed',
            jsonb_build_object('locationDays', p_location_days, 'photoDays', p_photo_days));
    return jsonb_build_object('success', true);
end;
$function$;
revoke all on function public.set_prosm_time_retention(integer, integer) from public, anon;
grant execute on function public.set_prosm_time_retention(integer, integer) to authenticated;

create or replace function public.get_prosm_time_retention()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CHANGES THE RETENTION'; end if;
    return (select jsonb_build_object('locationDays', location_retention_days, 'photoDays', photo_retention_days) from organization_settings where organization_id = v_org);
end;
$function$;
revoke all on function public.get_prosm_time_retention() from public, anon;
grant execute on function public.get_prosm_time_retention() to authenticated;

create or replace function public.purge_prosm_time_expired_location_samples()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_deleted_count integer;
begin
    with deleted as (
        delete from location_samples where retention_expires_at <= now() returning user_id
    ), counted as (
        select u.organization_id, count(*) as n from deleted d join users u on u.id = d.user_id group by 1
    ), logged as (
        insert into data_deletion_log (organization_id, kind, deleted_count)
        select organization_id, 'location_samples', n from counted
        returning deleted_count
    )
    select coalesce(sum(deleted_count), 0) into v_deleted_count from logged;
    return jsonb_build_object('success', true, 'deletedCount', v_deleted_count);
exception
    when others then
        raise exception 'PURGE PROSM TIME EXPIRED LOCATION SAMPLES FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.delete_prosm_time_camera_evidence_record(p_evidence_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
begin
    delete from camera_evidence where id = p_evidence_id returning organization_id into v_org;
    if v_org is not null then
        insert into data_deletion_log (organization_id, kind, deleted_count) values (v_org, 'camera_evidence', 1);
    end if;
    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DELETE PROSM TIME CAMERA EVIDENCE RECORD FAILED: %', sqlerrm;
end;
$function$;

commit;
