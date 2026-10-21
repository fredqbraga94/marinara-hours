-- Number on the app icon: how many time-off requests each subscribed phone's
-- manager still has to answer (Administrator: all in the unit; Kitchen/Floor
-- manager: their department), sent along with each notification.
-- Additive only: one new function. Nothing existing changes.
create or replace function public.mh_push_badges(p_location text)
returns table (id uuid, pending integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.id,
         (select count(*)::integer
            from public.leave_requests l
            join public.staff r on r.id = l.staff_id
           where l.status = 'PENDING' and r.location = p.location
             and (public.mh_scope(s.role) is null or r.department = public.mh_scope(s.role)))
    from public.push_subscriptions p
    join public.staff s on s.id = p.staff_id
   where p.active and p.location = p_location
$function$;
revoke all on function public.mh_push_badges(text) from public, anon, authenticated;
grant execute on function public.mh_push_badges(text) to service_role;
