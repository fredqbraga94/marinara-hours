-- Stock par level, like the Floor/Bar par sheet: per unit and department, a
-- list of items with their par. Someone counts what is there; the app compares
-- it with the par and says how much to order, grouped by supplier.
--
-- par        = what to keep in stock (e.g. 16 bottles)
-- par_extra  = optional second place, with its own par: "4bot + 3bar" means
--              par 4, par_extra 3, extra_label 'bar'; "1 + 1open" means par 1,
--              par_extra 1, extra_label 'open'
-- case_size  = bottles per box, the "(12)" on the sheet
-- order_by   = 'box' (round what is missing UP to whole boxes) or 'unit'
--
-- Additive only: new tables and new functions. Nothing existing is changed.
-- Tables are reached only through the functions below (service role); RLS is
-- on with no policies, so the public API keys cannot read or write them.

create table if not exists public.stock_suppliers (
  location text not null,
  department text not null check (department in ('Kitchen', 'Floor')),
  name text not null check (length(trim(name)) between 1 and 60),
  min_order integer check (min_order is null or min_order between 1 and 999),
  note text check (note is null or length(note) <= 200),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  primary key (location, department, name)
);

create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  department text not null check (department in ('Kitchen', 'Floor')),
  group_name text not null check (length(trim(group_name)) between 1 and 40),
  supplier text check (supplier is null or length(trim(supplier)) between 1 and 60),
  name text not null check (length(trim(name)) between 1 and 80),
  unit text check (unit is null or length(unit) <= 20),
  case_size integer check (case_size is null or case_size between 1 and 999),
  order_by text not null default 'unit' check (order_by in ('unit', 'box')),
  par numeric(8,1) not null default 0 check (par >= 0 and par <= 9999),
  par_extra numeric(8,1) check (par_extra is null or (par_extra >= 0 and par_extra <= 9999)),
  extra_label text check (extra_label is null or length(extra_label) <= 20),
  note text check (note is null or length(note) <= 200),
  sort_order integer not null default 0,
  active boolean not null default true,
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint stock_items_box_check check (order_by = 'unit' or case_size is not null)
);
create index if not exists stock_items_place_idx on public.stock_items (location, department, active, sort_order);

create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  department text not null check (department in ('Kitchen', 'Floor')),
  counted_by uuid references public.staff(id),
  counted_at timestamptz not null default now(),
  lines jsonb not null default '[]'::jsonb
);
create index if not exists stock_counts_place_idx on public.stock_counts (location, department, counted_at desc);

create table if not exists public.stock_audit (
  id bigint generated always as identity primary key,
  kind text not null,
  ref text not null,
  changed_by uuid references public.staff(id),
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz not null default now()
);

alter table public.stock_suppliers enable row level security;
alter table public.stock_items enable row level security;
alter table public.stock_counts enable row level security;
alter table public.stock_audit enable row level security;
revoke all on public.stock_suppliers, public.stock_items, public.stock_counts, public.stock_audit from anon, authenticated;

-- How much to order for one item. Same rule as the app's live preview.
create or replace function public.mh_stock_order(
  p_par numeric, p_qty numeric, p_par_extra numeric, p_qty_extra numeric,
  p_case_size integer, p_order_by text
)
returns jsonb
language sql
immutable
set search_path to 'public'
as $function$
  with m as (
    select greatest(coalesce(p_par, 0) - coalesce(p_qty, 0), 0)
         + case when p_par_extra is null then 0
                else greatest(p_par_extra - coalesce(p_qty_extra, 0), 0) end as missing
  )
  select jsonb_build_object(
    'missing', m.missing,
    'order_qty', case when p_order_by = 'box' and coalesce(p_case_size, 0) > 0
                      then ceil(m.missing / p_case_size) else ceil(m.missing) end,
    'order_unit', case when p_order_by = 'box' and coalesce(p_case_size, 0) > 0 then 'box' else 'unit' end)
  from m
$function$;

-- Which department a manager may use: their own when department-scoped,
-- otherwise the one asked for (Floor by default).
create or replace function public.mh_stock_department(p_role text, p_department text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_scope text := public.mh_scope(p_role);
  v_dep text := nullif(trim(coalesce(p_department, '')), '');
begin
  if v_scope is not null then
    if v_dep is not null and v_dep <> v_scope then raise exception 'DEPARTMENT_DENIED'; end if;
    return v_scope;
  end if;
  v_dep := coalesce(v_dep, 'Floor');
  if v_dep not in ('Floor', 'Kitchen') then raise exception 'INVALID_INPUT'; end if;
  return v_dep;
end $function$;

create or replace function public.mh_stock_item_json(i public.stock_items)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'department', i.department, 'group_name', i.group_name, 'supplier', i.supplier,
    'name', i.name, 'unit', i.unit, 'case_size', i.case_size, 'order_by', i.order_by,
    'par', i.par, 'par_extra', i.par_extra, 'extra_label', i.extra_label, 'note', i.note,
    'sort_order', i.sort_order, 'active', i.active, 'updated_at', i.updated_at)
$function$;

-- The list for one unit and department, the suppliers and the last count.
create or replace function public.manager_stock_list(
  p_manager_id uuid,
  p_location text,
  p_department text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_dep text := public.mh_stock_department(mgr.role, p_department);
  v_last public.stock_counts%rowtype;
begin
  select * into v_last from public.stock_counts
   where location = v_location and department = v_dep
   order by counted_at desc limit 1;

  return jsonb_build_object(
    'location', v_location,
    'department', v_dep,
    'can_choose_department', public.mh_scope(mgr.role) is null,
    'items', coalesce((
      select jsonb_agg(public.mh_stock_item_json(i) order by i.sort_order, i.name)
        from public.stock_items i
       where i.location = v_location and i.department = v_dep and i.active
    ), '[]'::jsonb),
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object('name', s.name, 'min_order', s.min_order, 'note', s.note) order by s.name)
        from public.stock_suppliers s
       where s.location = v_location and s.department = v_dep
    ), '[]'::jsonb),
    'last_count', case when v_last.id is null then null else jsonb_build_object(
      'id', v_last.id,
      'counted_at', v_last.counted_at,
      'counted_by', (select name from public.staff where id = v_last.counted_by),
      'lines', v_last.lines) end
  );
end $function$;

-- Add (no id) or change one item. p_item keys: id, department, group_name,
-- supplier, name, unit, case_size, order_by, par, par_extra, extra_label,
-- note, sort_order.
create or replace function public.manager_stock_item_save(
  p_manager_id uuid,
  p_location text,
  p_item jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_id uuid := nullif(p_item->>'id', '')::uuid;
  v_old public.stock_items%rowtype;
  v_new public.stock_items%rowtype;
  v_dep text;
  v_case integer := nullif(p_item->>'case_size', '')::integer;
  v_order_by text := coalesce(nullif(p_item->>'order_by', ''), 'unit');
  v_par_extra numeric := nullif(p_item->>'par_extra', '')::numeric;
begin
  if v_id is not null then
    select * into v_old from public.stock_items where id = v_id for update;
    if not found or not v_old.active or v_old.location is distinct from v_location then
      raise exception 'STOCK_ITEM_NOT_FOUND';
    end if;
    v_dep := public.mh_stock_department(mgr.role, v_old.department);
  else
    v_dep := public.mh_stock_department(mgr.role, p_item->>'department');
  end if;

  if nullif(trim(coalesce(p_item->>'name', '')), '') is null
     or nullif(trim(coalesce(p_item->>'group_name', '')), '') is null
     or v_order_by not in ('unit', 'box')
     or (v_order_by = 'box' and v_case is null) then
    raise exception 'INVALID_INPUT';
  end if;

  if v_id is null then
    insert into public.stock_items (location, department, group_name, supplier, name, unit, case_size, order_by,
                                    par, par_extra, extra_label, note, sort_order, updated_by)
    values (v_location, v_dep, trim(p_item->>'group_name'), nullif(trim(coalesce(p_item->>'supplier', '')), ''),
            trim(p_item->>'name'), nullif(trim(coalesce(p_item->>'unit', '')), ''), v_case, v_order_by,
            coalesce(nullif(p_item->>'par', '')::numeric, 0), v_par_extra,
            case when v_par_extra is null then null else nullif(trim(coalesce(p_item->>'extra_label', '')), '') end,
            nullif(trim(coalesce(p_item->>'note', '')), ''),
            coalesce(nullif(p_item->>'sort_order', '')::integer,
                     (select coalesce(max(sort_order), 0) + 10 from public.stock_items
                       where location = v_location and department = v_dep)),
            mgr.id)
    returning * into v_new;
  else
    update public.stock_items set
      group_name = trim(p_item->>'group_name'),
      supplier = nullif(trim(coalesce(p_item->>'supplier', '')), ''),
      name = trim(p_item->>'name'),
      unit = nullif(trim(coalesce(p_item->>'unit', '')), ''),
      case_size = v_case,
      order_by = v_order_by,
      par = coalesce(nullif(p_item->>'par', '')::numeric, 0),
      par_extra = v_par_extra,
      extra_label = case when v_par_extra is null then null else nullif(trim(coalesce(p_item->>'extra_label', '')), '') end,
      note = nullif(trim(coalesce(p_item->>'note', '')), ''),
      sort_order = coalesce(nullif(p_item->>'sort_order', '')::integer, sort_order),
      updated_by = mgr.id,
      updated_at = now()
    where id = v_id
    returning * into v_new;
  end if;

  insert into public.stock_audit (kind, ref, changed_by, old_value, new_value)
  values ('item', v_new.id::text, mgr.id,
          case when v_id is null then null else public.mh_stock_item_json(v_old) end,
          public.mh_stock_item_json(v_new));

  return public.mh_stock_item_json(v_new);
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'INVALID_INPUT';
end $function$;

-- Take an item off the list (kept for history, not deleted).
create or replace function public.manager_stock_item_remove(
  p_manager_id uuid,
  p_location text,
  p_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_old public.stock_items%rowtype;
begin
  select * into v_old from public.stock_items where id = p_item_id for update;
  if not found or not v_old.active or v_old.location is distinct from v_location then
    raise exception 'STOCK_ITEM_NOT_FOUND';
  end if;
  perform public.mh_stock_department(mgr.role, v_old.department);
  update public.stock_items set active = false, updated_by = mgr.id, updated_at = now() where id = p_item_id;
  insert into public.stock_audit (kind, ref, changed_by, old_value, new_value)
  values ('item_removed', p_item_id::text, mgr.id, public.mh_stock_item_json(v_old), null);
  return jsonb_build_object('id', p_item_id, 'active', false);
end $function$;

-- Add or change a supplier's minimum order (null = no minimum).
create or replace function public.manager_stock_supplier_save(
  p_manager_id uuid,
  p_location text,
  p_department text,
  p_name text,
  p_min_order integer,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_dep text := public.mh_stock_department(mgr.role, p_department);
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_old public.stock_suppliers%rowtype;
begin
  if v_name is null or (p_min_order is not null and (p_min_order < 1 or p_min_order > 999)) then
    raise exception 'INVALID_INPUT';
  end if;
  select * into v_old from public.stock_suppliers
   where location = v_location and department = v_dep and name = v_name for update;
  insert into public.stock_suppliers (location, department, name, min_order, note, updated_by, updated_at)
  values (v_location, v_dep, v_name, p_min_order, nullif(trim(coalesce(p_note, '')), ''), mgr.id, now())
  on conflict (location, department, name)
  do update set min_order = excluded.min_order, note = excluded.note,
                updated_by = excluded.updated_by, updated_at = now();
  insert into public.stock_audit (kind, ref, changed_by, old_value, new_value)
  values ('supplier', v_location || '/' || v_dep || '/' || v_name, mgr.id,
          case when v_old.name is null then null else jsonb_build_object('min_order', v_old.min_order, 'note', v_old.note) end,
          jsonb_build_object('min_order', p_min_order, 'note', nullif(trim(coalesce(p_note, '')), '')));
  return jsonb_build_object('name', v_name, 'min_order', p_min_order, 'note', nullif(trim(coalesce(p_note, '')), ''));
end $function$;

-- Save a count. p_lines: [{item_id, qty, qty_extra}]. Items left blank are
-- saved as not counted and ordered as nothing. Each line keeps a copy of the
-- item's par at that moment, so old counts stay readable after edits.
create or replace function public.manager_stock_count_save(
  p_manager_id uuid,
  p_location text,
  p_department text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_location text := case when mgr.role = 'admin' then coalesce(p_location, mgr.location) else mgr.location end;
  v_dep text := public.mh_stock_department(mgr.role, p_department);
  v_lines jsonb;
  v_row public.stock_counts%rowtype;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'INVALID_INPUT'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
     where (l->>'qty' is not null and ((l->>'qty')::numeric < 0 or (l->>'qty')::numeric > 99999))
        or (l->>'qty_extra' is not null and ((l->>'qty_extra')::numeric < 0 or (l->>'qty_extra')::numeric > 99999))
  ) then
    raise exception 'INVALID_INPUT';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'item_id', i.id, 'name', i.name, 'group_name', i.group_name, 'supplier', i.supplier,
             'unit', i.unit, 'case_size', i.case_size, 'order_by', i.order_by,
             'par', i.par, 'par_extra', i.par_extra, 'extra_label', i.extra_label,
             'qty', (l.v->>'qty')::numeric, 'qty_extra', (l.v->>'qty_extra')::numeric,
             'counted', l.v->>'qty' is not null or l.v->>'qty_extra' is not null)
           || case when l.v->>'qty' is null and l.v->>'qty_extra' is null
                   then jsonb_build_object('missing', null, 'order_qty', 0,
                          'order_unit', case when i.order_by = 'box' then 'box' else 'unit' end)
                   else public.mh_stock_order(i.par, (l.v->>'qty')::numeric, i.par_extra,
                                              (l.v->>'qty_extra')::numeric, i.case_size, i.order_by) end
           order by i.sort_order, i.name), '[]'::jsonb)
    into v_lines
    from public.stock_items i
    left join lateral (
      select x as v from jsonb_array_elements(p_lines) x
       where x->>'item_id' = i.id::text limit 1
    ) l on true
   where i.location = v_location and i.department = v_dep and i.active;

  insert into public.stock_counts (location, department, counted_by, lines)
  values (v_location, v_dep, mgr.id, v_lines)
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'counted_at', v_row.counted_at,
                            'counted_by', mgr.name, 'lines', v_row.lines);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'INVALID_INPUT';
end $function$;

revoke all on function public.mh_stock_order(numeric, numeric, numeric, numeric, integer, text) from public, anon, authenticated;
revoke all on function public.mh_stock_department(text, text) from public, anon, authenticated;
revoke all on function public.mh_stock_item_json(public.stock_items) from public, anon, authenticated;
revoke all on function public.manager_stock_list(uuid, text, text) from public, anon, authenticated;
revoke all on function public.manager_stock_item_save(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.manager_stock_item_remove(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.manager_stock_supplier_save(uuid, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.manager_stock_count_save(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.manager_stock_list(uuid, text, text) to service_role;
grant execute on function public.manager_stock_item_save(uuid, text, jsonb) to service_role;
grant execute on function public.manager_stock_item_remove(uuid, text, uuid) to service_role;
grant execute on function public.manager_stock_supplier_save(uuid, text, text, text, integer, text) to service_role;
grant execute on function public.manager_stock_count_save(uuid, text, text, jsonb) to service_role;

-- Starting list for Hawthorne Floor/Bar, copied from the par sheet
-- (Marinara_par_level). Only added when that list is still empty, so it never
-- overwrites changes made in the app.
insert into public.stock_suppliers (location, department, name, min_order, note)
values ('Hawthorne', 'Floor', 'Global', null, null),
       ('Hawthorne', 'Floor', 'RiverCity', null, null),
       ('Hawthorne', 'Floor', 'Tom San Pellegrino (SMS)', 9, null)
on conflict (location, department, name) do nothing;

insert into public.stock_items (location, department, group_name, supplier, name, unit, case_size, order_by,
                                par, par_extra, extra_label, note, sort_order)
select 'Hawthorne', 'Floor', v.group_name, v.supplier, v.name, v.unit, v.case_size, v.order_by,
       v.par, v.par_extra, v.extra_label, v.note, v.ord * 10
  from (values
    (1,  'Sparkling', null, 'Prosecco Santa Margherita', 'bot', 6,  'box',  24, null, null, 'Par on the sheet: 4 boxes'),
    (2,  'Sparkling', null, 'Pierre de Ville Brut',      'bot', 6,  'box',  16, null, null, 'Sheet: 16bot / 4box'),
    (3,  'Sparkling', null, 'Canevel Setage Prosecco',   'bot', 6,  'unit', 1,  null, null, 'Sheet: 1'),
    (4,  'Sparkling', null, 'Champagne Jacquart Brut',   'bot', 6,  'unit', 4,  null, null, null),
    (5,  'Sparkling', null, 'Bellavista Alma',           'bot', 6,  'unit', 4,  null, null, null),
    (6,  'White', null, 'House White Alex Hills',        'bot', 12, 'box',  16, null, null, null),
    (7,  'White', null, 'Moscato',                       'bot', 12, 'box',  16, null, null, null),
    (8,  'White', null, 'Fantini Chardonnay',            'bot', 12, 'box',  16, null, null, null),
    (9,  'White', null, 'Riesling Em''s Table',          'bot', 12, 'box',  8,  null, null, null),
    (10, 'White', null, 'Cielo 3 Passo Bianco',          'bot', 6,  'box',  6,  null, null, null),
    (11, 'White', null, 'Fantini Pinot Grigio',          'bot', 12, 'box',  20, null, null, null),
    (12, 'White', null, 'Ten Rocks',                     'bot', 12, 'box',  20, null, null, null),
    (13, 'White', null, 'Mesa Vermentino',               'bot', 6,  'box',  8,  null, null, null),
    (14, 'White', null, 'Haselg Chardo Staff',           'bot', 6,  'box',  4,  null, null, null),
    (15, 'White', null, 'Houdini Sauv Blanc',            'bot', 6,  'box',  4,  null, null, null),
    (16, 'White', null, 'Santa Margh Pinot Grigio',      'bot', 6,  'box',  8,  null, null, null),
    (17, 'White', null, 'Block 88 Sauvignon Blanc',      'bot', 12, 'unit', 6,  null, null, 'Rossane'),
    (18, 'White', null, 'Cookoothama 375ml',             'bot', null, 'unit', 1, 1,  'open', null),
    (19, 'Rosé', null, 'Fantini Rose',                   'bot', 12, 'box',  18, null, null, null),
    (20, 'Rosé', null, 'Pasqua "Superfluo"',             'bot', 6,  'box',  10, null, null, null),
    (21, 'Vodka', null, 'Fluence',                       'bot', 6,  'unit', 3,  null, null, null),
    (22, 'Red', null, 'House Red Alex Hills',            'bot', 12, 'box',  18, null, null, null),
    (23, 'Red', null, 'Fantini Montepulciano',           'bot', 12, 'box',  16, null, null, null),
    (24, 'Red', null, 'Haselg First Cut Cab Sauv',       'bot', 12, 'box',  16, null, null, null),
    (25, 'Red', null, 'Pasqua Merlot',                   'bot', 6,  'box',  12, null, null, null),
    (26, 'Red', null, 'Smidge Houdini Shiraz',           'bot', 6,  'box',  18, null, null, 'Sheet: 18bot / 4box'),
    (27, 'Red', null, 'Astoria Pinot Noir',              'bot', 6,  'box',  36, null, null, 'Rossane. Par on the sheet: 6 box'),
    (28, 'Red', null, 'Pasqua Valpolicella',             'bot', 6,  'box',  10, null, null, 'Sheet: 10bot / 3box'),
    (29, 'Red', null, 'Don Camillo Sangio Cab',          'bot', 6,  'box',  28, null, null, null),
    (30, 'Red', null, 'Il Passo Verde Nero d''Avola',    'bot', 12, 'box',  6,  null, null, null),
    (31, 'Red', null, 'Haselg GSM Switch',               'bot', 6,  'box',  8,  null, null, null),
    (32, 'Red', null, 'Chianti Raffia Antica Cinta',     'bot', 6,  'box',  10, null, null, null),
    (33, 'Red', null, 'Lawsons Dry Hills Pinot Noir',    'bot', 12, 'box',  8,  null, null, null),
    (34, 'Red', null, 'Smidge Adamo Shiraz',             'bot', 6,  'box',  6,  null, null, null),
    (35, 'Red', null, 'Appassimento',                    'bot', 6,  'box',  8,  null, null, null),
    (36, 'Reserve white', null, 'Torre Mora Etna Bianco',    'bot', 6, 'unit', 4, 3, 'bar', null),
    (37, 'Reserve white', null, 'Jones Road Chardonnay',     'bot', 6, 'unit', 4, 3, 'bar', null),
    (38, 'Reserve white', null, 'Pasqua ''Hey French''',     'bot', 6, 'unit', 4, 3, 'bar', null),
    (39, 'Reserve white', null, 'Bellavista Uccel Chardo',   'bot', 6, 'unit', 3, 3, 'bar', null),
    (40, 'Reserve red', null, 'Primitivo del Sal 70yo Vine', 'bot', 6, 'unit', 4, 3, 'bar', null),
    (41, 'Reserve red', null, 'Amarone',                     'bot', 6, 'unit', 3, 3, 'bar', null),
    (42, 'Reserve red', null, 'Brunello di Montalcino',      'bot', 6, 'unit', 4, 3, 'bar', null),
    (43, 'Reserve red', null, 'Chianti Riserva DOCG',        'bot', 6, 'unit', 6, 3, 'bar', null),
    (44, 'Beers', 'Global', 'Peroni',          null, null, 'unit', 9, null, null, null),
    (45, 'Beers', 'Global', 'Menabrea',        null, null, 'unit', 2, null, null, null),
    (46, 'Beers', 'Global', 'Nazionale',       null, null, 'unit', 6, null, null, null),
    (47, 'Beers', 'Global', 'Isaac',           null, null, 'unit', 7, null, null, null),
    (48, 'Beers', 'RiverCity', 'Corona',       null, null, 'unit', 4, null, null, null),
    (49, 'Beers', 'RiverCity', 'Peroni 3.5%',  null, null, 'unit', 3, null, null, null),
    (50, 'Beers', 'RiverCity', 'Pure Blonde',  null, null, 'unit', 1, 1, 'open', null),
    (51, 'Beers', 'RiverCity', 'Crown',        null, null, 'unit', 1, 1, 'open', null),
    (52, 'Beers', 'RiverCity', 'Boag''s',      null, null, 'unit', 1, 1, 'open', null),
    (53, 'Beers', 'RiverCity', 'Libera 0%',    null, null, 'unit', 1, 1, 'open', null),
    (54, 'Beers', 'RiverCity', 'Apple Cider',  null, null, 'unit', 1, 1, 'open', null),
    (55, 'Beers', 'RiverCity', 'Pear Cider',   null, null, 'unit', 1, 1, 'open', null),
    (56, 'Soft drinks', 'Global', 'Ginger Beer', null, null, 'unit', 1, 1, 'open', null),
    (57, 'Soft drinks', 'Tom San Pellegrino (SMS)', 'S. Pellegrino', null, null, 'unit', 7, null, null, null),
    (58, 'Soft drinks', 'Tom San Pellegrino (SMS)', 'Panna',         null, null, 'unit', 7, null, null, null),
    (59, 'Soft drinks', 'Tom San Pellegrino (SMS)', 'Chinotto',      null, null, 'unit', 1, 1, 'open', null),
    (60, 'Soft drinks', 'Tom San Pellegrino (SMS)', 'Limonata',      null, null, 'unit', 1, 1, 'open', null),
    (61, 'Soft drinks', 'Tom San Pellegrino (SMS)', 'Aranciata Rossa', null, null, 'unit', 1, 1, 'open', null)
  ) as v(ord, group_name, supplier, name, unit, case_size, order_by, par, par_extra, extra_label, note)
 where not exists (select 1 from public.stock_items where location = 'Hawthorne' and department = 'Floor');
