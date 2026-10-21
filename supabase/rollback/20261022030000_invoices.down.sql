-- Rollback of 20261022030000_invoices.sql (removes supplier invoices).
drop function if exists public.manager_invoice_usage(uuid, text, integer);
drop function if exists public.manager_invoice_price_changes(uuid, text);
drop function if exists public.manager_invoice_remove(uuid, text, uuid);
drop function if exists public.manager_invoice_get(uuid, text, uuid);
drop function if exists public.manager_invoice_list(uuid, text, date, date);
drop function if exists public.manager_invoice_save(uuid, text, jsonb);
drop function if exists public.mh_invoice_json(public.supplier_invoices);
drop function if exists public.mh_invoice_admin(uuid, text);
drop table if exists public.supplier_invoice_lines;
drop table if exists public.supplier_invoices;
