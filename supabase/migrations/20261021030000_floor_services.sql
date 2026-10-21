-- Floor and Bar can now be rostered with L / D / L/D like the Kitchen (mainly
-- for full and part-time staff). Usual times agreed with the owner
-- 2026-10-21: lunch 11:00-15:00, dinner 17:00-22:00, the same for Floor and
-- Bar. Used only to turn L / D into planned hours (and the student visa
-- check). Data only: new rows, nothing existing is changed.
insert into public.roster_services (location, department, service, start_time, end_time)
select u.location, 'Floor', v.service, v.start_time, v.end_time
  from (values ('Hawthorne'), ('Paddington'), ('Clayfield')) u(location),
       (values ('L', time '11:00', time '15:00'), ('D', time '17:00', time '22:00')) v(service, start_time, end_time)
on conflict (location, department, service) do nothing;

insert into public.roster_position_services (location, position, service, start_time, end_time)
select u.location, v.position, v.service, v.start_time, v.end_time
  from (values ('Hawthorne'), ('Paddington'), ('Clayfield')) u(location),
       (values ('Floor', 'L', time '11:00', time '15:00'),
               ('Floor', 'D', time '17:00', time '22:00'),
               ('Bar', 'L', time '11:00', time '15:00'),
               ('Bar', 'D', time '17:00', time '22:00')) v(position, service, start_time, end_time)
on conflict (location, position, service) do nothing;
