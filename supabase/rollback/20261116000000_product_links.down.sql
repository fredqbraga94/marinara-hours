-- Undo 20261116000000_product_links.sql: the two functions as they were
-- (20261115000000_product_packs.sql), then the new function and table.

create or replace function public.manager_invoice_price_book(p_manager_id uuid, p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
begin
  return jsonb_build_object('products', coalesce((
    with lines as (
      select i.id as invoice_id, i.supplier, i.invoice_date, i.created_at,
             coalesce(l.code, lower(l.description)) as product_key,
             l.code, l.description, l.unit, l.unit_price, false as from_list
        from public.supplier_invoice_lines l
        join public.supplier_invoices i on i.id = l.invoice_id
       where i.location = v_location and i.department = public.mh_invoice_dept() and i.active and i.kind = 'invoice'
         and l.unit_price is not null and l.unit_price > 0
         and l.description !~* '(fuel|freight|delivery)\s*(levy|charge|fee)|^delivery'
      union all
      -- The supplier's price lists: a price on that date, not a purchase.
      select pl.id, pl.supplier, pl.list_date, pl.created_at,
             coalesce(it.code, lower(it.description)), it.code, it.description, it.unit, it.unit_price, true
        from public.supplier_price_list_items it
        join public.supplier_price_lists pl on pl.id = it.list_id
       where pl.location = v_location and pl.department = public.mh_invoice_dept() and pl.active
    ),
    -- One price per product per invoice (a product listed twice on the same
    -- invoice is averaged).
    per_invoice as (
      select supplier, product_key, invoice_id, invoice_date, max(created_at) as created_at,
             round(avg(unit_price), 4) as price, bool_or(from_list) as from_list
        from lines
       group by supplier, product_key, invoice_id, invoice_date
    ),
    ranked as (
      select p.*, row_number() over (partition by supplier, product_key order by invoice_date desc, created_at desc) as rn
        from per_invoice p
    ),
    latest as (select * from ranked where rn = 1),
    prev as (
      select distinct on (r.supplier, r.product_key) r.supplier, r.product_key, r.price, r.invoice_date
        from ranked r
        join latest lt on lt.supplier = r.supplier and lt.product_key = r.product_key
       where r.rn > 1 and r.price <> lt.price
       order by r.supplier, r.product_key, r.invoice_date desc, r.created_at desc
    ),
    label as (
      select distinct on (supplier, product_key) supplier, product_key, code, description, unit
        from lines
       order by supplier, product_key, invoice_date desc, created_at desc
    )
    select jsonb_agg(jsonb_build_object(
             'supplier', lt.supplier, 'product_key', lt.product_key,
             'code', lb.code, 'description', lb.description, 'unit', lb.unit,
             -- Units to a carton when the supplier counts single units ("Ctn [4]").
             'pack', coalesce(
                        (select pk.pack from public.supplier_product_packs pk
                          where pk.location = v_location and lower(pk.supplier) = lower(lt.supplier) and pk.product_key = lt.product_key),
                        (select max(((regexp_match(x.unit, '^\s*c(?:tn|arton)s?\s*\[(\d+)\]\s*$', 'i'))[1])::int)
                           from lines x where x.supplier = lt.supplier and x.product_key = lt.product_key)),
             -- Units in a carton typed by a manager (Products → tap a product).
             'pack_saved', exists (select 1 from public.supplier_product_packs pk
                          where pk.location = v_location and lower(pk.supplier) = lower(lt.supplier) and pk.product_key = lt.product_key),
             'times', (select count(*) from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key and not x.from_list),
             'last_from_list', lt.from_list,
             'last_price', lt.price, 'last_date', lt.invoice_date,
             'previous_price', pv.price, 'previous_date', pv.invoice_date,
             'change_pct', case when pv.price is null then null
                                else round((lt.price - pv.price) / pv.price * 100, 1) end,
             'history', (select jsonb_agg(jsonb_build_object('date', x.invoice_date, 'price', x.price, 'list', x.from_list)
                                          order by x.invoice_date, x.created_at)
                           from per_invoice x where x.supplier = lt.supplier and x.product_key = lt.product_key))
           order by lower(lb.description))
      from latest lt
      join label lb on lb.supplier = lt.supplier and lb.product_key = lt.product_key
      left join prev pv on pv.supplier = lt.supplier and pv.product_key = lt.product_key
  ), '[]'::jsonb));
end $function$;

-- One invoice call on one list (as before), plus pack_save {supplier, product_key, pack}.
create or replace function public.manager_invoice_call(p_manager_id uuid, p_location text, p_department text, p_action text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  mgr public.staff%rowtype := public.mh_manager(p_manager_id);
  v_dep text := public.mh_stock_department(mgr.role, coalesce(nullif(p_department, ''), public.mh_scope(mgr.role), 'Kitchen'));
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
begin
  perform set_config('mh.invoice_department', v_dep, true);
  return case p_action
    when 'save' then public.manager_invoice_save(p_manager_id, p_location, v_args->'invoice')
    when 'list' then public.manager_invoice_list(p_manager_id, p_location, (v_args->>'from')::date, (v_args->>'to')::date)
                     || jsonb_build_object('department', v_dep, 'can_choose_department', public.mh_scope(mgr.role) is null)
    when 'get' then public.manager_invoice_get(p_manager_id, p_location, (v_args->>'id')::uuid)
    when 'remove' then public.manager_invoice_remove(p_manager_id, p_location, (v_args->>'id')::uuid)
    when 'price_changes' then public.manager_invoice_price_changes(p_manager_id, p_location)
    when 'price_book' then public.manager_invoice_price_book(p_manager_id, p_location)
                     || jsonb_build_object('department', v_dep)
    when 'top_products' then public.manager_invoice_top_products(p_manager_id, p_location)
                     || jsonb_build_object('department', v_dep)
    when 'usage' then public.manager_invoice_usage(p_manager_id, p_location, (v_args->>'weeks')::integer)
                     || jsonb_build_object('department', v_dep)
    when 'price_list_save' then public.mh_price_list_save(p_manager_id, p_location, v_args->'list')
    when 'price_lists' then public.mh_price_lists(p_manager_id, p_location) || jsonb_build_object('department', v_dep)
    when 'pack_save' then public.mh_product_pack_save(p_manager_id, p_location, v_args)
    else null end;
end $function$;

drop function if exists public.mh_product_link_save(uuid, text, jsonb);
drop table if exists public.supplier_product_links;
