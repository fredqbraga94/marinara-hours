-- Rollback of 20261103000000_shopping_order.sql: back to urgent first, then oldest first.
drop function if exists public.manager_shopping_move(uuid, uuid, integer);
create or replace function public.manager_shopping_list(p_manager_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
begin
  return jsonb_build_object(
    'open', coalesce((select jsonb_agg(public.mh_shopping_json(i) order by i.urgent desc, i.created_at)
                        from public.shopping_items i where i.location = mgr.location and i.status = 'open'), '[]'::jsonb),
    'bought', coalesce((select jsonb_agg(public.mh_shopping_json(i) order by i.done_at desc)
                          from public.shopping_items i
                         where i.location = mgr.location and i.status = 'bought' and i.done_at > now() - interval '14 days'), '[]'::jsonb));
end $function$;
alter table public.shopping_items drop column if exists position;
