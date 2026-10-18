\set ON_ERROR_STOP 0
set client_min_messages = warning;
create temp table r(test text, expected text, got text);
create or replace function pg_temp.t(p_test text, p_expected text, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  begin execute p_sql; v := 'OK';
  exception when others then v := sqlerrm; end;
  insert into r values (p_test, p_expected, v);
end $$;

-- seed: people in 3 units
insert into public.staff (id,name,pin_hash,department,location,role) values
 ('00000000-0000-0000-0000-00000000000a','Admin Fred', extensions.crypt('9001',extensions.gen_salt('bf')),'Floor','Hawthorne','admin'),
 ('00000000-0000-0000-0000-0000000000a1','GM Hawthorne', extensions.crypt('9002',extensions.gen_salt('bf')),'Floor','Hawthorne','manager'),
 ('00000000-0000-0000-0000-0000000000b1','Floor Mgr Padd', extensions.crypt('9003',extensions.gen_salt('bf')),'Floor','Paddington','floor_manager'),
 ('00000000-0000-0000-0000-0000000000b2','Kitchen Mgr Padd', extensions.crypt('9004',extensions.gen_salt('bf')),'Kitchen','Paddington','kitchen_manager'),
 ('00000000-0000-0000-0000-0000000000b3','Floor Staff Padd', extensions.crypt('9005',extensions.gen_salt('bf')),'Floor','Paddington','staff'),
 ('00000000-0000-0000-0000-0000000000b4','Kitchen Staff Padd', extensions.crypt('9006',extensions.gen_salt('bf')),'Kitchen','Paddington','staff'),
 ('00000000-0000-0000-0000-0000000000a3','Staff Hawthorne', extensions.crypt('9007',extensions.gen_salt('bf')),'Floor','Hawthorne','staff');

select pg_temp.t('unidade invalida recusada','check constraint',
 $$insert into public.staff(name,pin_hash,department,location) values ('X','x','Floor','Sydney')$$);

-- Floor manager Paddington
select pg_temp.t('FloorMgr Padd cria Floor em Padd','OK',
 $$select public.manager_create_staff_in_unit('00000000-0000-0000-0000-0000000000b1','Novo Floor','1111','Floor',null)$$);
select pg_temp.t('FloorMgr Padd NAO cria Kitchen','DEPARTMENT_DENIED',
 $$select public.manager_create_staff_in_unit('00000000-0000-0000-0000-0000000000b1','Novo K','1112','Kitchen',null)$$);
select pg_temp.t('FloorMgr Padd NAO cria em Hawthorne','LOCATION_DENIED',
 $$select public.manager_create_staff_in_unit('00000000-0000-0000-0000-0000000000b1','Novo H','1113','Floor','Hawthorne')$$);
select pg_temp.t('FloorMgr Padd NAO edita staff Hawthorne','STAFF_NOT_FOUND',
 $$select public.manager_update_staff_audited('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a3','Y','Floor',null,null)$$);
select pg_temp.t('FloorMgr Padd NAO edita kitchen Padd','DEPARTMENT_DENIED',
 $$select public.manager_update_staff_audited('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b4','Y','Kitchen',null,null)$$);
select pg_temp.t('FloorMgr Padd cria turno floor Padd','OK',
 $$select public.manager_create_shift('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b3', now()-interval '30 hours', now()-interval '22 hours', 30, null)$$);
select pg_temp.t('FloorMgr Padd NAO cria turno kitchen','DEPARTMENT_DENIED',
 $$select public.manager_create_shift('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b4', now()-interval '30 hours', now()-interval '22 hours', 30, null)$$);

-- Kitchen manager Paddington
select pg_temp.t('KitchenMgr Padd cria turno kitchen Padd','OK',
 $$select public.manager_create_shift('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b4', now()-interval '30 hours', now()-interval '22 hours', 0, null)$$);
select pg_temp.t('KitchenMgr Padd NAO cria turno floor','DEPARTMENT_DENIED',
 $$select public.manager_create_shift('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b3', now()-interval '50 hours', now()-interval '45 hours', 0, null)$$);

-- GM Hawthorne (comportamento de hoje)
select pg_temp.t('GM Hawthorne NAO mexe em Padd','STAFF_NOT_FOUND',
 $$select public.manager_create_shift('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b3', now()-interval '80 hours', now()-interval '75 hours', 0, null)$$);
select pg_temp.t('GM Hawthorne cria staff Hawthorne (como hoje)','OK',
 $$select public.manager_create_staff_audited('00000000-0000-0000-0000-0000000000a1','Novo Hawthorne','2221','Kitchen')$$);
select pg_temp.t('GM Hawthorne NAO cria admin','ADMIN_REQUIRED',
 $$select public.manager_update_staff_audited('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a3','Staff Hawthorne','Floor',null,'admin')$$);
select pg_temp.t('GM Hawthorne NAO desativa admin','ADMIN_REQUIRED',
 $$select public.manager_toggle_staff_audited('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a')$$);

-- Admin
select pg_temp.t('Admin cria staff em Clayfield','OK',
 $$select public.manager_create_staff_in_unit('00000000-0000-0000-0000-00000000000a','Novo Clay','3331','Kitchen','Clayfield')$$);
select pg_temp.t('Admin edita staff Padd','OK',
 $$select public.manager_update_staff_audited('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000b4','Kitchen Staff Padd','Kitchen',null,null)$$);
select pg_temp.t('Admin cria turno Padd','OK',
 $$select public.manager_create_shift('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000b3', now()-interval '100 hours', now()-interval '95 hours', 0, null)$$);
select pg_temp.t('Admin promove kitchen Padd a manager','OK',
 $$select public.manager_update_staff_audited('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000b4','Kitchen Staff Padd','Kitchen',null,'kitchen_manager')$$);
select pg_temp.t('Admin NAO cria em unidade invalida','check constraint',
 $$select public.manager_create_staff_in_unit('00000000-0000-0000-0000-00000000000a','X','4441','Floor','Sydney')$$);
select pg_temp.t('PIN repetido entre unidades recusado','PIN_IN_USE',
 $$select public.manager_create_staff_in_unit('00000000-0000-0000-0000-00000000000a','Dup','9005','Floor','Clayfield')$$);

-- Approve shift across units
select pg_temp.t('GM Hawthorne NAO aprova turno Padd','SHIFT_NOT_FOUND',
 $$select public.manager_set_shift_approved('00000000-0000-0000-0000-0000000000a1',(select id from public.shifts where staff_id='00000000-0000-0000-0000-0000000000b3' limit 1), true)$$);
select pg_temp.t('Admin aprova turno Padd','OK',
 $$select public.manager_set_shift_approved('00000000-0000-0000-0000-00000000000a',(select id from public.shifts where staff_id='00000000-0000-0000-0000-0000000000b3' limit 1), true)$$);

select case when got = expected or got like '%'||expected||'%' then 'PASS' else 'FAIL' end res, test, expected, left(got,70) got from r;
select count(*) filter (where not (got = expected or got like '%'||expected||'%')) as failures, count(*) total from r;
