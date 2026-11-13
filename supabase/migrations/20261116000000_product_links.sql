-- The same product under two names (a supplier renamed it, or its price list
-- and its invoices call it differently, e.g. "P3 Big Blend Shredded Cheese 2kg"
-- and "Big Blend P3 Cheese Shredded Blend (Dairy Pride) 2kg"): in Finance →
-- Products a manager taps one and says "Same as..." the other. Products then
-- shows one product with all its prices. Nothing on an invoice changes, and
-- "Separate" undoes it. Spending and dish costs are not changed.
-- Changes: one new table, one new function, and two functions redefined (the
-- price book joins the names; the invoice call can save a link).

create table if not exists public.supplier_product_links (
  location text not null,
  supplier text not null check (length(trim(supplier)) between 1 and 80),
  product_key text not null check (length(product_key) between 1 and 300),
  same_as text not null check (length(same_as) between 1 and 300 and same_as <> product_key),
  updated_by uuid references public.staff(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists supplier_product_links_key_idx
  on public.supplier_product_links (location, lower(supplier), product_key);
alter table public.supplier_product_links enable row level security;
revoke all on public.supplier_product_links from anon, authenticated;

-- Join one product to another (or, with same_as null, separate it again).
-- p_args: {supplier, product_key, same_as}. Links stay one step: a product
-- joined to one that is itself joined goes to that one, and products already
-- joined to this one follow it.
create or replace function public.mh_product_link_save(p_manager_id uuid, p_location text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location text := public.mh_invoice_admin(p_manager_id, p_location);
  v_supplier text := trim(coalesce(p_args->>'supplier', ''));
  v_key text := coalesce(p_args->>'product_key', '');
  v_to text := nullif(p_args->>'same_as', '');
begin
  if v_supplier = '' or v_key = '' or length(v_supplier) > 80 or length(v_key) > 300 or length(coalesce(v_to, '')) > 300 then
    raise exception 'INVALID_INPUT';
  end if;
  if v_to is null then
    delete from public.supplier_product_links
     where location = v_location and lower(supplier) = lower(v_supplier) and product_key = v_key;
  else
    select coalesce((select same_as from public.supplier_product_links
                      where location = v_location and lower(supplier) = lower(v_supplier) and product_key = v_to), v_to)
      into v_to;
    if v_to = v_key then raise exception 'INVALID_INPUT'; end if;
    update public.supplier_product_links set same_as = v_to, updated_by = p_manager_id, updated_at = now()
     where location = v_location and lower(supplier) = lower(v_supplier) and same_as = v_key;
    insert into public.supplier_product_links (location, supplier, product_key, same_as, updated_by)
    values (v_location, v_supplier, v_key, v_to, p_manager_id)
    on conflict (location, lower(supplier), product_key)
    do update set same_as = excluded.same_as, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.staff_audit (staff_id, staff_ref, changed_by, action, old_data, new_data)
  values (null, p_manager_id, p_manager_id, 'manager_product_link_save', null,
          jsonb_build_object('supplier', v_supplier, 'product_key', v_key, 'same_as', v_to));
  return jsonb_build_object('supplier', v_supplier, 'product_key', v_key, 'same_as', v_to);
end $function$;

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
    with raw as (
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
    -- Two names for one product (a manager said "Same as..."): one key.
    lines as (
      select r.invoice_id, r.supplier, r.invoice_date, r.created_at,
             coalesce(lk.same_as, r.product_key) as product_key, r.product_key as own_key,
             r.code, r.description, r.unit, r.unit_price, r.from_list
        from raw r
        left join public.supplier_product_links lk
          on lk.location = v_location and lower(lk.supplier) = lower(r.supplier) and lk.product_key = r.product_key
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
             -- The other names joined to this product (Products → "Same as...").
             'merged', (select jsonb_agg(jsonb_build_object('product_key', m.own_key, 'code', m.code, 'description', m.description) order by m.description)
                          from (select distinct on (x.own_key) x.own_key, x.code, x.description
                                  from lines x where x.supplier = lt.supplier and x.product_key = lt.product_key and x.own_key <> lt.product_key
                                 order by x.own_key, x.invoice_date desc, x.created_at desc) m),
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

-- One invoice call on one list (as before), plus link_save {supplier, product_key, same_as}.
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
    when 'link_save' then public.mh_product_link_save(p_manager_id, p_location, v_args)
    else null end;
end $function$;

revoke all on function public.mh_product_link_save(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.mh_product_link_save(uuid, text, jsonb) to service_role;
