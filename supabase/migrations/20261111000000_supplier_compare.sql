-- Compare suppliers: the same product bought from two suppliers, at the price
-- per kg, litre or each, and what the dearer one costs more a month. The app
-- groups products with the same name by itself; a manager can also put two
-- products together, take one out of a group, and say what one invoice price
-- buys when it is not clear from the product line ("a carton has 6 × 2.5 kg").
-- Administrator and Kitchen Manager only (same as Invoices).
-- Additive only: one new table and two new functions. Nothing existing changes.

create table if not exists public.supplier_product_compare (
  location text not null,
  supplier text not null check (length(trim(supplier)) between 1 and 80),
  product_key text not null check (length(product_key) between 1 and 300),
  pack_count numeric check (pack_count is null or (pack_count > 0 and pack_count <= 10000)),
  pack_size numeric check (pack_size is null or (pack_size > 0 and pack_size <= 100000)),
  pack_unit text check (pack_unit is null or pack_unit in ('kg', 'g', 'l', 'ml', 'each')),
  group_id uuid,
  not_grouped boolean not null default false,
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now(),
  primary key (location, supplier, product_key),
  check ((pack_count is null) = (pack_size is null) and (pack_size is null) = (pack_unit is null))
);
create index if not exists supplier_product_compare_group_idx on public.supplier_product_compare (location, group_id) where group_id is not null;
alter table public.supplier_product_compare enable row level security;
revoke all on public.supplier_product_compare from anon, authenticated;

-- What the Compare view needs on top of the price book: the packs and groups
-- saved here, the packs known from ingredient links, and how many of each
-- product were bought in the last 90 days.
create or replace function public.manager_supplier_compare(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return jsonb_build_object(
    'location', v_location,
    'saved', coalesce((
      select jsonb_agg(jsonb_build_object(
               'supplier', c.supplier, 'product_key', c.product_key,
               'pack', case when c.pack_count is null then null else jsonb_build_object('count', c.pack_count, 'size', c.pack_size, 'unit', c.pack_unit) end,
               'group_id', c.group_id, 'not_grouped', c.not_grouped))
        from public.supplier_product_compare c where c.location = v_location), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
               'supplier', l.supplier, 'product_key', l.product_key,
               'pack', jsonb_build_object('count', l.pack_count, 'size', l.pack_size, 'unit', l.pack_unit)))
        from public.recipe_ingredient_costs l where l.location = v_location and l.active), '[]'::jsonb),
    'bought', coalesce((
      select jsonb_agg(jsonb_build_object('supplier', b.supplier, 'product_key', b.product_key, 'qty_90d', b.qty, 'invoices_90d', b.n))
        from (select i.supplier, coalesce(l.code, lower(l.description)) as product_key,
                     round(sum(coalesce(l.qty, 1)), 3) as qty, count(distinct i.id) as n
                from public.supplier_invoice_lines l
                join public.supplier_invoices i on i.id = l.invoice_id
               where i.location = v_location and i.active and i.kind = 'invoice'
                 and i.invoice_date >= (now() at time zone 'Australia/Brisbane')::date - 90
               group by 1, 2) b), '[]'::jsonb));
end $function$;

-- Save one product's compare settings. p_data: {supplier, product_key,
-- pack?: {count, size, unit} | null, group_with?: {supplier, product_key},
-- ungroup?: true}. Only the keys sent are changed.
create or replace function public.manager_supplier_compare_save(p_manager_id uuid, p_location text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_sup text := trim(coalesce(p_data->>'supplier', ''));
  v_key text := coalesce(p_data->>'product_key', '');
  v_osup text;
  v_okey text;
  v_group uuid;
  v_pack jsonb := p_data->'pack';
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or v_sup = '' or v_key = '' then raise exception 'INVALID_INPUT'; end if;
  if not exists (select 1 from public.mh_invoice_products(v_location) p where p.supplier = v_sup and p.product_key = v_key) then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  insert into public.supplier_product_compare (location, supplier, product_key, updated_by)
  values (v_location, v_sup, v_key, p_manager_id)
  on conflict (location, supplier, product_key) do nothing;
  if p_data ? 'pack' then
    if v_pack is null or jsonb_typeof(v_pack) = 'null' then
      update public.supplier_product_compare set pack_count = null, pack_size = null, pack_unit = null, updated_by = p_manager_id, updated_at = now()
       where location = v_location and supplier = v_sup and product_key = v_key;
    else
      update public.supplier_product_compare
         set pack_count = (v_pack->>'count')::numeric, pack_size = (v_pack->>'size')::numeric, pack_unit = v_pack->>'unit',
             updated_by = p_manager_id, updated_at = now()
       where location = v_location and supplier = v_sup and product_key = v_key;
    end if;
  end if;
  if jsonb_typeof(p_data->'group_with') = 'object' then
    v_osup := trim(coalesce(p_data->'group_with'->>'supplier', ''));
    v_okey := coalesce(p_data->'group_with'->>'product_key', '');
    if v_osup = v_sup and v_okey = v_key then raise exception 'INVALID_INPUT'; end if;
    if not exists (select 1 from public.mh_invoice_products(v_location) p where p.supplier = v_osup and p.product_key = v_okey) then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    insert into public.supplier_product_compare (location, supplier, product_key, updated_by)
    values (v_location, v_osup, v_okey, p_manager_id)
    on conflict (location, supplier, product_key) do nothing;
    select coalesce(
             (select group_id from public.supplier_product_compare where location = v_location and supplier = v_osup and product_key = v_okey),
             (select group_id from public.supplier_product_compare where location = v_location and supplier = v_sup and product_key = v_key),
             gen_random_uuid())
      into v_group;
    update public.supplier_product_compare set group_id = v_group, not_grouped = false, updated_by = p_manager_id, updated_at = now()
     where location = v_location and ((supplier = v_sup and product_key = v_key) or (supplier = v_osup and product_key = v_okey));
  elsif coalesce((p_data->>'ungroup')::boolean, false) then
    update public.supplier_product_compare set group_id = null, not_grouped = true, updated_by = p_manager_id, updated_at = now()
     where location = v_location and supplier = v_sup and product_key = v_key;
  end if;
  return (select jsonb_build_object('supplier', c.supplier, 'product_key', c.product_key,
            'pack', case when c.pack_count is null then null else jsonb_build_object('count', c.pack_count, 'size', c.pack_size, 'unit', c.pack_unit) end,
            'group_id', c.group_id, 'not_grouped', c.not_grouped)
            from public.supplier_product_compare c where c.location = v_location and c.supplier = v_sup and c.product_key = v_key);
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then raise exception 'INVALID_INPUT';
end $function$;

revoke all on function public.manager_supplier_compare(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_supplier_compare_save(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.manager_supplier_compare(uuid, text) to service_role;
grant execute on function public.manager_supplier_compare_save(uuid, text, jsonb) to service_role;
