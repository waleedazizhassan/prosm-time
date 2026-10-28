-- v2.3.55 (owner 2026-10-28: "remove the law text - this is an international
-- program, not only Egyptian; keep everything else"): the leave types keep
-- their days, rules and order; only the notes naming a country's labour law
-- go - from the types every organisation already has, and from the ones a
-- new organisation is given. A note an Owner wrote themselves is kept.
-- prosm_time_seed_leave_types is the live definition with those notes empty.

begin;

update public.leave_types set legal_note = null where legal_note like 'Law 14/2025%';

create or replace function public.prosm_time_seed_leave_types(p_organization_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    insert into leave_types (organization_id, key, name, is_paid, annual_days, service_tiers, special_needs_days, enforce_balance,
                             max_days_per_request, max_times_in_service, min_service_years, requires_document, sort_order, legal_note)
    values
        (p_organization_id, 'annual', 'Annual', true, null,
         '[{"minYears":0,"days":15},{"minYears":1,"days":21},{"minYears":10,"days":30}]'::jsonb, 45, false, null, null, null, false, 10,
         null),
        (p_organization_id, 'emergency', 'Casual', true, 7, null, null, true, 2, null, null, false, 20,
         null),
        (p_organization_id, 'sick', 'Sick', true, null, null, null, false, null, null, null, true, 30,
         'With a medical report.'),
        (p_organization_id, 'unpaid', 'Unpaid', false, null, null, null, false, null, null, null, false, 40, null),
        (p_organization_id, 'hajj', 'Hajj or Umrah', true, null, null, null, false, 30, 1, 5, false, 50,
         null),
        (p_organization_id, 'bereavement', 'Bereavement', true, null, null, null, false, 3, null, null, false, 60,
         null),
        (p_organization_id, 'paternity', 'Paternity', true, null, null, null, false, 1, 3, null, false, 70,
         null),
        (p_organization_id, 'other', 'Other', true, null, null, null, false, null, null, null, false, 90, null)
    on conflict (organization_id, key) do nothing;
$function$;

commit;
