-- Owner 2026-11-13 ("review the governance and the permissions very well"). The review found that someone
-- holding "assign permissions" - not the owner - could change their own permissions, give others permissions
-- they do not hold themselves, and change the permissions of someone of their own rank or above. From now on,
-- for anyone but the owner (and the owner's full deputy, who acts as the owner):
--   * nobody changes their own permissions;
--   * only someone of a higher rank is changed (an employee or supervisor by a manager, ...);
--   * a permission is given only by someone who holds it.
-- Taking a permission away from someone below stays possible. Granting and clearing both follow it (clearing
-- a "taken away" gives the permission back, so it is a grant too).
-- Rollback: re-run set_ and clear_prosm_time_user_permission_override from before this migration.

begin;

do $$
declare
    v_anchor text := '        raise exception ''THE OWNER''''S AUTHORITY CANNOT BE OVERRIDDEN'';
    end if;';
    v_rule text := '
    -- 2026-11-13 governance: oneself never; a higher rank only; a permission only from someone who holds it
    if not public.current_prosm_time_user_is_owner() then
        if p_target_user_id = v_caller_id then
            raise exception ''YOU CANNOT CHANGE YOUR OWN PERMISSIONS'';
        end if;
        if not public.prosm_time_can_act_on_behalf_of(v_caller_id, p_target_user_id) then
            raise exception ''YOU MAY ONLY CHANGE THE PERMISSIONS OF SOMEONE BELOW YOU'';
        end if;
        if %GRANTING% and not (p_permission_key = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
            raise exception ''A MANAGER MAY ONLY PASS ON PERMISSIONS THEY HOLD'';
        end if;
    end if;';
    v_def text;
begin
    v_def := pg_get_functiondef('public.set_prosm_time_user_permission_override(uuid, text, boolean, text)'::regprocedure);
    if position(v_anchor in v_def) = 0 then raise exception 'set override: anchor not found'; end if;
    execute replace(v_def, v_anchor, v_anchor || replace(v_rule, '%GRANTING%', 'p_is_granted'));

    v_def := pg_get_functiondef('public.clear_prosm_time_user_permission_override(uuid, text, text)'::regprocedure);
    if position(v_anchor in v_def) = 0 then raise exception 'clear override: anchor not found'; end if;
    -- clearing a "taken away" gives the permission back: a grant
    execute replace(v_def, v_anchor, v_anchor || replace(v_rule, '%GRANTING%',
        'exists (select 1 from user_permission_overrides upo join permissions p on p.id = upo.permission_id where upo.user_id = p_target_user_id and p.permission_key = p_permission_key and upo.is_granted = false)'));
end $$;

commit;
