-- Rollback of 20261027000000_invoice_price_book.sql (removes the price book reader).
drop function if exists public.manager_invoice_price_book(uuid, text);
