-- Shopping list: put the items in any order with up/down arrows. Urgent items
-- stay on top; inside urgent and inside the rest, the order is the one chosen
-- (new items go to the end of their group).
-- Additive only: one new column, one new function; manager_shopping_list orders
-- by it (same list, same fields). Rollback restores the previous order.

alter table public.shopping_items add column if not exists position integer;

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
    'open', coalesce((select jsonb_agg(public.mh_shopping_json(i) order by i.urgent desc, i.position nulls last, i.created_at)
                        from public.shopping_items i where i.location = mgr.location and i.status = 'open'), '[]'::jsonb),
    'bought', coalesce((select jsonb_agg(public.mh_shopping_json(i) order by i.done_at desc)
                          from public.shopping_items i
                         where i.location = mgr.location and i.status = 'bought' and i.done_at > now() - interval '14 days'), '[]'::jsonb));
end $function$;

-- Move an item still to buy one place up (p_dir -1) or down (+1) inside its
-- group (urgent or not). The whole group is numbered again, so the order holds.
create or replace function public.manager_shopping_move(p_manager_id uuid, p_id uuid, p_dir integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_item public.shopping_items%rowtype;
  v_ids uuid[];
  v_at integer;
  v_to integer;
begin
  if p_dir is null or p_dir not in (-1, 1) then raise exception 'INVALID_INPUT'; end if;
  select * into v_item from public.shopping_items where id = p_id and location = mgr.location and status = 'open';
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  perform 1 from public.shopping_items where location = mgr.location and status = 'open' for update;
  select array_agg(i.id order by i.position nulls last, i.created_at) into v_ids
    from public.shopping_items i where i.location = mgr.location and i.status = 'open' and i.urgent = v_item.urgent;
  v_at := array_position(v_ids, p_id);
  v_to := v_at + p_dir;
  if v_to >= 1 and v_to <= array_length(v_ids, 1) then
    v_ids[v_at] := v_ids[v_to];
    v_ids[v_to] := p_id;
  end if;
  update public.shopping_items i set position = x.n
    from unnest(v_ids) with ordinality as x(id, n) where i.id = x.id;
  return jsonb_build_object('id', p_id, 'moved', v_to >= 1 and v_to <= array_length(v_ids, 1));
end $function$;

revoke all on function public.manager_shopping_move(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.manager_shopping_move(uuid, uuid, integer) to service_role;
