-- Release audit SA-13 (2026-11-16): HR and department managers decide leave under the governance model, but the
-- leave row and its documents (a medical certificate) were readable only by site managers - they approved blind.
-- Whoever may decide a person's leave (either step, under the organisation's model) now reads that person's leave
-- requests and their documents. Nothing else widens.
-- Rollback: re-create both policies without prosm_time_may_decide_leave_of; drop the function.

begin;

create or replace function public.prosm_time_may_decide_leave_of(p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_request_decider('leave', public.current_prosm_time_user_id(), p_subject, 1::smallint)
        or public.prosm_time_request_decider('leave', public.current_prosm_time_user_id(), p_subject, 2::smallint);
$$;
revoke all on function public.prosm_time_may_decide_leave_of(uuid) from public, anon;
grant execute on function public.prosm_time_may_decide_leave_of(uuid) to authenticated;

drop policy if exists "members can view own leave requests" on public.leave_requests;
create policy "members can view own leave requests"
on public.leave_requests for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or (select public.current_prosm_time_user_is_owner())
        or ('leave.approve' = any(coalesce((select public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id())), array[]::text[]))
            and public.prosm_time_caller_has_authority_over(user_id))
        or public.prosm_time_may_decide_leave_of(user_id)
    )
);

drop policy if exists "leave documents visible to the person or their reviewers" on storage.objects;
create policy "leave documents visible to the person or their reviewers"
on storage.objects for select to authenticated
using (
    bucket_id = 'leave-documents'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
    and (
        (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text
        or public.current_prosm_time_user_is_owner()
        or ('leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and public.prosm_time_caller_has_authority_over(((storage.foldername(name))[2])::uuid))
        or public.prosm_time_may_decide_leave_of(((storage.foldername(name))[2])::uuid)
    )
);

commit;
