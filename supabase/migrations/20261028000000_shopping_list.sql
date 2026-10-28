-- Shopping list: things the restaurant needs to buy that do not come from the
-- suppliers (a new knife, paper towels). Any manager (Administrator, Kitchen or
-- Floor Manager) can add an item, mark it bought, or remove it. The list keeps
-- who asked, who bought it and when. One list per location.
-- Additive only: one new table and three new functions. Nothing existing changes.

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  name text not null check (length(trim(name)) between 1 and 80),
  qty text check (qty is null or length(qty) <= 40),
  note text check (note is null or length(note) <= 200),
  urgent boolean not null default false,
  status text not null default 'open' check (status in ('open', 'bought', 'removed')),
  created_by uuid references public.staff(id),
  created_at timestamptz not null default now(),
  done_by uuid references public.staff(id),
  done_at timestamptz
);
create index if not exists shopping_items_location_idx on public.shopping_items (location, status, created_at);

alter table public.shopping_items enable row level security;
revoke all on public.shopping_items from anon, authenticated;

create or replace function public.mh_shopping_json(i public.shopping_items)
returns jsonb language sql stable set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'name', i.name, 'qty', i.qty, 'note', i.note, 'urgent', i.urgent, 'status', i.status,
    'created_at', i.created_at, 'created_by', (select s.name from public.staff s where s.id = i.created_by),
    'done_at', i.done_at, 'done_by', (select s.name from public.staff s where s.id = i.done_by))
$function$;

-- Items still to buy, plus what was bought in the last 14 days.
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

-- Add an item, or edit one still to buy. p_item: {id?, name, qty, note, urgent}.
create or replace function public.manager_shopping_save(p_manager_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_name text := left(trim(coalesce(p_item->>'name', '')), 80);
  v_qty text := nullif(left(trim(coalesce(p_item->>'qty', '')), 40), '');
  v_note text := nullif(left(trim(coalesce(p_item->>'note', '')), 200), '');
  v_urgent boolean := coalesce((p_item->>'urgent')::boolean, false);
  v_row public.shopping_items%rowtype;
begin
  if v_name = '' then raise exception 'INVALID_INPUT'; end if;
  if p_item ? 'id' and p_item->>'id' is not null then
    update public.shopping_items
       set name = v_name, qty = v_qty, note = v_note, urgent = v_urgent
     where id = (p_item->>'id')::uuid and location = mgr.location and status = 'open'
    returning * into v_row;
    if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  else
    insert into public.shopping_items (location, name, qty, note, urgent, created_by)
    values (mgr.location, v_name, v_qty, v_note, v_urgent, p_manager_id)
    returning * into v_row;
  end if;
  return public.mh_shopping_json(v_row);
end $function$;

-- Mark an item bought, back to buy, or remove it. p_status: bought | open | removed.
create or replace function public.manager_shopping_mark(p_manager_id uuid, p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_row public.shopping_items%rowtype;
begin
  if p_status not in ('bought', 'open', 'removed') then raise exception 'INVALID_INPUT'; end if;
  update public.shopping_items
     set status = p_status,
         done_by = case when p_status = 'open' then null else p_manager_id end,
         done_at = case when p_status = 'open' then null else now() end
   where id = p_id and location = mgr.location and status <> 'removed'
  returning * into v_row;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  return public.mh_shopping_json(v_row);
end $function$;

revoke all on function public.mh_shopping_json(public.shopping_items) from public, anon, authenticated;
revoke all on function public.manager_shopping_list(uuid) from public, anon, authenticated;
revoke all on function public.manager_shopping_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_shopping_mark(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mh_shopping_json(public.shopping_items) to service_role;
grant execute on function public.manager_shopping_list(uuid) to service_role;
grant execute on function public.manager_shopping_save(uuid, jsonb) to service_role;
grant execute on function public.manager_shopping_mark(uuid, uuid, text) to service_role;
