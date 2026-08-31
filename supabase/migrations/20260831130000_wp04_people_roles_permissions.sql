-- PROSM Time Implementation Master File V3.0, WP-04 (§38: "People &
-- Roles & Permissions | Employee profiles, invitations, granular
-- permission model (§9), device binding").
--
-- §9: "Permissions must be granular and configurable... The
-- authorization model must support these action types per resource:
-- VIEW, CREATE, EDIT, DELETE, EXECUTE, APPROVE, EXPORT, ADMINISTER...
-- Role/permission checks are enforced server-side (RLS + Edge
-- Functions) - the client only reflects, never enforces."
--
-- §12: "Granular permission assignment per administrator, per §9 -
-- roles are a convenient bundle, not a hard ceiling; individual
-- permissions can be added/removed per admin." Modeled as two layers:
-- role_default_permissions (the bundle) + user_permission_overrides
-- (the per-admin add/remove on top) - a user's real effective
-- permission set is always role-bundle XOR override, computed by
-- get_prosm_time_effective_permissions(), never duplicated ad hoc.
--
-- §12: "Employees receive invitations or controlled onboarding rather
-- than administrators handling employee passwords." An invitation
-- creates the real Supabase Auth account immediately (random password
-- nobody ever sees, mirrors PROSM Platform's own establish-
-- organization-owner pattern) plus a one-time verification code the
-- inviting admin hands to the employee out-of-band - email DELIVERY of
-- that code is WP-13's job (Notifications), not invented here as a
-- fake send.
--
-- §12: "Device binding: each employee's account can be linked to one
-- or more approved devices for attendance actions." Table + admin
-- governance RPCs only in this migration - the actual "block Clock In
-- from an unrecognized device" enforcement is WP-06's job (Attendance
-- Core), once there is a real Clock In action to enforce it against.

begin;

-- ============================================================
-- 1. Permission catalog (§9's own listed permissions, one row per
--    resource.action)
-- ============================================================

create table public.permissions (
    id uuid primary key default gen_random_uuid(),
    permission_key text not null unique,
    resource text not null,
    action_type text not null check (action_type in ('VIEW', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'APPROVE', 'EXPORT', 'ADMINISTER')),
    name text not null,
    description text,
    created_at timestamptz not null default now()
);

insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('employees.view', 'employees', 'VIEW', 'View employees', 'View employee profiles.'),
    ('employees.create', 'employees', 'CREATE', 'Create employees', 'Invite/create employee accounts.'),
    ('employees.edit', 'employees', 'EDIT', 'Edit employees', 'Edit employee profiles.'),
    ('employees.manage_accounts', 'employees', 'ADMINISTER', 'Manage employee accounts', 'Suspend/reactivate employee accounts.'),
    ('attendance.view', 'attendance', 'VIEW', 'View attendance', 'View attendance records.'),
    ('attendance.clock_in_on_behalf', 'attendance', 'EXECUTE', 'Clock in on behalf', 'Create a Clock In on behalf of an employee (§10).'),
    ('attendance.clock_out_on_behalf', 'attendance', 'EXECUTE', 'Clock out on behalf', 'Create a Clock Out on behalf of an employee (§10).'),
    ('attendance.correct', 'attendance', 'EDIT', 'Correct attendance', 'Apply controlled attendance corrections.'),
    ('gps_settings.manage', 'gps_settings', 'ADMINISTER', 'Manage GPS settings', 'Configure geofence/accuracy policy.'),
    ('sites.manage', 'sites', 'ADMINISTER', 'Manage sites', 'Create/edit worksites.'),
    ('projects.manage', 'projects', 'ADMINISTER', 'Manage projects', 'Create/edit projects.'),
    ('schedules.manage', 'schedules', 'ADMINISTER', 'Manage schedules', 'Create/edit work schedules.'),
    ('reports.view', 'reports', 'VIEW', 'View reports', 'View operational reports.'),
    ('reports.generate_pdf', 'reports', 'EXPORT', 'Generate PDF reports', 'Export reports as PDF.'),
    ('timesheets.generate', 'timesheets', 'CREATE', 'Generate timesheets', 'Generate monthly timesheets.'),
    ('timesheets.approve', 'timesheets', 'APPROVE', 'Approve timesheets', 'Approve/lock timesheets.'),
    ('exceptions.manage', 'exceptions', 'ADMINISTER', 'Manage exceptions', 'Review/act on presence exceptions.'),
    ('notifications.manage', 'notifications', 'ADMINISTER', 'Manage notifications', 'Configure notification policy.'),
    ('settings.manage', 'settings', 'ADMINISTER', 'Manage settings', 'Configure organization settings.'),
    ('administrators.manage', 'administrators', 'ADMINISTER', 'Manage administrators', 'Manage administrator accounts.'),
    ('permissions.assign', 'permissions', 'ADMINISTER', 'Assign or revoke permissions', 'Grant/revoke individual permission overrides.');

-- ============================================================
-- 2. Role default bundles ("a convenient bundle, not a hard ceiling").
--    The Master File names the five roles and the permission list but
--    not an exact matrix - this is a reasonable, explicit, documented
--    default assignment (§23: "Policy decisions are explicit and
--    configurable rather than hidden in UI code"), adjustable later by
--    editing this table, never hidden in application code. Owner gets
--    the full catalog explicitly (not a code special-case) so
--    get_prosm_time_effective_permissions() needs no owner branch.
-- ============================================================

create table public.role_default_permissions (
    id uuid primary key default gen_random_uuid(),
    role_id uuid not null references public.roles(id) on delete cascade,
    permission_id uuid not null references public.permissions(id) on delete cascade,
    unique (role_id, permission_id)
);

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p where r.role_key = 'owner';

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.permission_key in (
    'employees.view', 'attendance.view', 'attendance.clock_in_on_behalf', 'attendance.clock_out_on_behalf',
    'attendance.correct', 'sites.manage', 'projects.manage', 'schedules.manage', 'reports.view',
    'reports.generate_pdf', 'timesheets.generate', 'timesheets.approve', 'exceptions.manage'
) where r.role_key = 'manager';

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.permission_key in (
    'employees.view', 'attendance.view', 'attendance.clock_in_on_behalf', 'attendance.clock_out_on_behalf',
    'reports.view', 'exceptions.manage'
) where r.role_key = 'supervisor';

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.permission_key in ('attendance.view')
where r.role_key = 'employee';

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.permission_key in ('employees.view', 'attendance.view', 'reports.view')
where r.role_key = 'read_only';

-- ============================================================
-- 3. Per-admin overrides - the "not a hard ceiling" half.
--    is_granted = true adds a permission the role bundle doesn't have;
--    is_granted = false revokes one the role bundle does have. Never
--    targets the Owner (enforced in the RPC, §9: Owner authority is
--    structural, not a revocable grant).
-- ============================================================

create table public.user_permission_overrides (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    permission_id uuid not null references public.permissions(id) on delete cascade,
    is_granted boolean not null,
    granted_by uuid references public.users(id) on delete set null,
    reason text,
    created_at timestamptz not null default now(),
    unique (user_id, permission_id)
);

-- ============================================================
-- 4. Invitations - the real, controlled onboarding path (§12).
-- ============================================================

create table public.user_invitations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references public.users(id) on delete cascade,
    verification_code text not null,
    status text not null default 'PENDING' check (status in ('PENDING', 'CONSUMED', 'EXPIRED')),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
);

-- ============================================================
-- 5. Device binding (§12) - table + admin governance only in WP-04;
--    Clock In enforcement is WP-06's job.
-- ============================================================

create table public.device_bindings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    device_identifier text not null,
    device_label text,
    status text not null default 'approved' check (status in ('approved', 'pending', 'blocked')),
    approved_by uuid references public.users(id) on delete set null,
    approved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, device_identifier)
);

create index user_permission_overrides_user_id_idx on public.user_permission_overrides(user_id);
create index device_bindings_user_id_idx on public.device_bindings(user_id);

-- ============================================================
-- 6. RLS
-- ============================================================

alter table public.permissions enable row level security;
alter table public.role_default_permissions enable row level security;
alter table public.user_permission_overrides enable row level security;
alter table public.user_invitations enable row level security;
alter table public.device_bindings enable row level security;

revoke all on public.permissions from anon, authenticated;
revoke all on public.role_default_permissions from anon, authenticated;
revoke all on public.user_permission_overrides from anon, authenticated;
revoke all on public.user_invitations from anon, authenticated;
revoke all on public.device_bindings from anon, authenticated;

grant select on public.permissions to authenticated;
grant select on public.role_default_permissions to authenticated;
grant select on public.user_permission_overrides to authenticated;
grant select on public.device_bindings to authenticated;
-- user_invitations intentionally gets no SELECT grant to authenticated
-- at all - it holds a live verification code; the only legal readers
-- are service-role Edge Functions (redeem-invitation) and the RPCs
-- below, never a direct client query.

-- Global catalogs (§9's fixed vocabulary) - readable by any
-- authenticated user, same posture as `roles` in WP-03.
create policy "authenticated users can view the permission catalog"
on public.permissions for select to authenticated
using (true);

create policy "authenticated users can view role default permissions"
on public.role_default_permissions for select to authenticated
using (true);

create policy "members can view permission overrides in own organization"
on public.user_permission_overrides for select to authenticated
using (user_id in (select id from users where organization_id = public.current_prosm_time_organization_id()));

create policy "members can view device bindings in own organization"
on public.device_bindings for select to authenticated
using (user_id in (select id from users where organization_id = public.current_prosm_time_organization_id()));

-- ============================================================
-- 7. Effective-permission resolution - the one real source of "can
--    this user do X" (§9: enforced server-side, client only reflects).
--    Callable by any authenticated user for their OWN permissions;
--    checking someone else's requires the caller to already hold
--    'administrators.manage' or 'permissions.assign' (or be Owner) -
--    enforced inside the function itself since it is SECURITY DEFINER.
-- ============================================================

create or replace function public.get_prosm_time_effective_permissions(p_user_id uuid default null)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_target_id uuid;
    v_caller_org uuid;
    v_target_org uuid;
    v_caller_permissions text[];
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    v_target_id := coalesce(p_user_id, v_caller_id);

    if v_target_id <> v_caller_id then
        v_caller_org := public.current_prosm_time_organization_id();
        select organization_id into v_target_org from users where id = v_target_id;
        if v_target_org is null or v_target_org <> v_caller_org then
            raise exception 'USER NOT FOUND';
        end if;

        select array_agg(p.permission_key) into v_caller_permissions
        from role_default_permissions rdp
        join permissions p on p.id = rdp.permission_id
        join users u on u.role_id = rdp.role_id
        where u.id = v_caller_id;

        if not (
            'administrators.manage' = any(coalesce(v_caller_permissions, array[]::text[]))
            or 'permissions.assign' = any(coalesce(v_caller_permissions, array[]::text[]))
            or public.current_prosm_time_user_is_owner()
        ) then
            raise exception 'INSUFFICIENT AUTHORITY TO VIEW ANOTHER USER''S PERMISSIONS';
        end if;
    end if;

    return (
        select array_agg(distinct permission_key) from (
            select p.permission_key
            from role_default_permissions rdp
            join permissions p on p.id = rdp.permission_id
            join users u on u.role_id = rdp.role_id
            where u.id = v_target_id
            union
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = true
            except
            select p.permission_key
            from user_permission_overrides upo
            join permissions p on p.id = upo.permission_id
            where upo.user_id = v_target_id and upo.is_granted = false
        ) effective
    );
exception
    when others then
        raise exception 'GET PROSM TIME EFFECTIVE PERMISSIONS FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.get_prosm_time_effective_permissions(uuid) to authenticated;

-- ============================================================
-- 8. Permission grant/revoke RPCs - gated on the caller already
--    holding 'permissions.assign' (or being Owner); never targets the
--    Owner (§9: Owner authority is structural, not revocable).
-- ============================================================

create or replace function public.set_prosm_time_user_permission_override(
    p_target_user_id uuid,
    p_permission_key text,
    p_is_granted boolean,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_target users%rowtype;
    v_permission_id uuid;
    v_override_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'PERMISSIONS.ASSIGN AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_target from users where id = p_target_user_id and organization_id = v_caller_org;
    if v_target.id is null then
        raise exception 'USER NOT FOUND';
    end if;

    if v_target.is_owner then
        raise exception 'THE OWNER''S AUTHORITY CANNOT BE OVERRIDDEN';
    end if;

    select id into v_permission_id from permissions where permission_key = p_permission_key;
    if v_permission_id is null then
        raise exception 'UNKNOWN PERMISSION KEY';
    end if;

    insert into user_permission_overrides (user_id, permission_id, is_granted, granted_by, reason)
    values (p_target_user_id, v_permission_id, p_is_granted, v_caller_id, p_reason)
    on conflict (user_id, permission_id)
    do update set is_granted = excluded.is_granted, granted_by = excluded.granted_by, reason = excluded.reason, created_at = now()
    returning id into v_override_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_target_user_id,
        case when p_is_granted then 'PERMISSION_GRANTED' else 'PERMISSION_REVOKED' end,
        'user_permission_overrides', v_override_id,
        'Permission ' || p_permission_key || (case when p_is_granted then ' granted to ' else ' revoked from ' end) || v_target.email || '.',
        p_reason, jsonb_build_object('permissionKey', p_permission_key, 'isGranted', p_is_granted)
    );

    return jsonb_build_object('success', true, 'overrideId', v_override_id);
exception
    when others then
        raise exception 'SET PROSM TIME USER PERMISSION OVERRIDE FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.clear_prosm_time_user_permission_override(
    p_target_user_id uuid,
    p_permission_key text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_permission_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if not (
        public.current_prosm_time_user_is_owner()
        or 'permissions.assign' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'PERMISSIONS.ASSIGN AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    if not exists (select 1 from users where id = p_target_user_id and organization_id = v_caller_org) then
        raise exception 'USER NOT FOUND';
    end if;

    select id into v_permission_id from permissions where permission_key = p_permission_key;
    if v_permission_id is null then
        raise exception 'UNKNOWN PERMISSION KEY';
    end if;

    delete from user_permission_overrides where user_id = p_target_user_id and permission_id = v_permission_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, context)
    values (
        v_caller_org, v_caller_id, p_target_user_id, 'PERMISSION_OVERRIDE_CLEARED', 'user_permission_overrides', p_target_user_id,
        'Permission override for ' || p_permission_key || ' cleared - reverted to role default.', p_reason,
        jsonb_build_object('permissionKey', p_permission_key)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CLEAR PROSM TIME USER PERMISSION OVERRIDE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.set_prosm_time_user_permission_override(uuid, text, boolean, text) to authenticated;
grant execute on function public.clear_prosm_time_user_permission_override(uuid, text, text) to authenticated;

-- ============================================================
-- 9. Invitation RPCs. create_invited_prosm_time_user is service_role-
--    only (called from invite-user Edge Function, which already
--    created the real Auth account) - mirrors bootstrap_prosm_time_
--    organization's own posture exactly. redeem_prosm_time_invitation
--    is also service_role-only (called from redeem-invitation Edge
--    Function, whose caller has no session yet by definition).
-- ============================================================

create or replace function public.create_invited_prosm_time_user(
    p_organization_id uuid,
    p_auth_user_id uuid,
    p_actor_user_id uuid,
    p_role_key text,
    p_email text,
    p_full_name text,
    p_verification_code text,
    p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_role_id uuid;
    v_user_id uuid;
begin
    if p_role_key not in ('manager', 'supervisor', 'employee', 'read_only') then
        raise exception 'INVALID ROLE FOR AN INVITED USER';
    end if;

    select id into v_role_id from roles where role_key = p_role_key;
    if v_role_id is null then
        raise exception 'ROLE NOT FOUND';
    end if;

    if exists (select 1 from users where organization_id = p_organization_id and email = lower(trim(p_email))) then
        raise exception 'A USER WITH THIS EMAIL ALREADY EXISTS IN THIS ORGANIZATION';
    end if;

    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (p_auth_user_id, p_organization_id, v_role_id, lower(trim(p_email)), p_full_name, 'invited', false)
    returning id into v_user_id;

    insert into user_invitations (user_id, verification_code, status, expires_at)
    values (v_user_id, p_verification_code, 'PENDING', p_expires_at);

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        p_organization_id, p_actor_user_id, v_user_id, 'USER_INVITED', 'users', v_user_id,
        'Invited ' || p_email || ' as ' || p_role_key || '.', jsonb_build_object('roleKey', p_role_key)
    );

    return jsonb_build_object('success', true, 'userId', v_user_id);
exception
    when unique_violation then
        raise exception 'A USER WITH THIS EMAIL ALREADY EXISTS IN THIS ORGANIZATION';
    when others then
        raise exception 'CREATE INVITED PROSM TIME USER FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.redeem_prosm_time_invitation(
    p_email text,
    p_verification_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user users%rowtype;
    v_invitation user_invitations%rowtype;
begin
    select * into v_user from users where email = lower(trim(p_email)) and status = 'invited';
    if v_user.id is null then
        raise exception 'NO PENDING INVITATION FOUND FOR THIS EMAIL';
    end if;

    select * into v_invitation from user_invitations where user_id = v_user.id;
    if v_invitation.id is null then
        raise exception 'NO PENDING INVITATION FOUND FOR THIS EMAIL';
    end if;

    if v_invitation.status <> 'PENDING' then
        raise exception 'THIS INVITATION HAS ALREADY BEEN USED';
    end if;

    if v_invitation.expires_at <= now() then
        update user_invitations set status = 'EXPIRED' where id = v_invitation.id;
        raise exception 'THIS INVITATION HAS EXPIRED';
    end if;

    if v_invitation.verification_code <> p_verification_code then
        raise exception 'INVALID VERIFICATION CODE';
    end if;

    update user_invitations set status = 'CONSUMED', consumed_at = now() where id = v_invitation.id;
    update users set status = 'active', updated_at = now() where id = v_user.id;

    insert into audit_logs (organization_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_user.organization_id, v_user.id, 'USER_INVITATION_REDEEMED', 'users', v_user.id, v_user.email || ' redeemed their invitation and set their password.');

    return jsonb_build_object('success', true, 'userId', v_user.id, 'authUserId', v_user.auth_user_id);
exception
    when others then
        raise exception 'REDEEM PROSM TIME INVITATION FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.create_invited_prosm_time_user(uuid, uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_invited_prosm_time_user(uuid, uuid, uuid, text, text, text, text, timestamptz) to service_role;

revoke execute on function public.redeem_prosm_time_invitation(text, text) from public, anon, authenticated;
grant execute on function public.redeem_prosm_time_invitation(text, text) to service_role;

-- ============================================================
-- 10. Device binding governance RPCs.
-- ============================================================

create or replace function public.set_prosm_time_device_binding_status(
    p_device_binding_id uuid,
    p_status text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_binding device_bindings%rowtype;
    v_target_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if p_status not in ('approved', 'blocked') then
        raise exception 'INVALID DEVICE BINDING STATUS';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'employees.manage_accounts' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'EMPLOYEES.MANAGE_ACCOUNTS AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_binding from device_bindings where id = p_device_binding_id;
    if v_binding.id is null then
        raise exception 'DEVICE BINDING NOT FOUND';
    end if;

    select organization_id into v_target_org from users where id = v_binding.user_id;
    if v_target_org is null or v_target_org <> v_caller_org then
        raise exception 'DEVICE BINDING NOT FOUND';
    end if;

    update device_bindings
    set status = p_status, approved_by = case when p_status = 'approved' then v_caller_id else approved_by end,
        approved_at = case when p_status = 'approved' then now() else approved_at end, updated_at = now()
    where id = p_device_binding_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_caller_org, v_caller_id, v_binding.user_id,
        case when p_status = 'approved' then 'DEVICE_BINDING_APPROVED' else 'DEVICE_BINDING_BLOCKED' end,
        'device_bindings', p_device_binding_id, 'Device binding set to ' || p_status || '.', p_reason
    );

    return jsonb_build_object('success', true, 'deviceBindingId', p_device_binding_id, 'status', p_status);
exception
    when others then
        raise exception 'SET PROSM TIME DEVICE BINDING STATUS FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.set_prosm_time_device_binding_status(uuid, text, text) to authenticated;

commit;
