-- Rollback of 20261028040000_top_products.sql (the imported supplier history goes away; saved invoices are untouched).
drop function if exists public.manager_invoice_top_products(uuid, text);
drop table if exists public.supplier_history_products;
drop table if exists public.supplier_history_imports;
