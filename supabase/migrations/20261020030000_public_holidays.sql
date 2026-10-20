-- Queensland public holidays, shown on the roster and as a reminder on the
-- manager home. Official dates from qld.gov.au (checked 2026-10-20).
-- region: QLD = whole state; BRISBANE = Brisbane area only (Ekka). All three
-- units (Hawthorne, Paddington, Clayfield) are in the Brisbane area.
-- part_day: set when only part of the day is a holiday (Christmas Eve 6pm-midnight).
-- Additive only: one new table, read by the Edge Function (service role).
-- Future years: add rows with the same insert (new dates are announced by
-- the Queensland Government each year).

create table if not exists public.public_holidays (
  holiday_date date not null,
  name text not null,
  region text not null default 'QLD' check (region in ('QLD', 'BRISBANE')),
  part_day text,
  primary key (holiday_date, name)
);

alter table public.public_holidays enable row level security;
revoke all on public.public_holidays from anon, authenticated;

insert into public.public_holidays (holiday_date, name, region, part_day) values
  ('2026-01-01', 'New Year''s Day', 'QLD', null),
  ('2026-01-26', 'Australia Day', 'QLD', null),
  ('2026-04-03', 'Good Friday', 'QLD', null),
  ('2026-04-04', 'Day after Good Friday', 'QLD', null),
  ('2026-04-05', 'Easter Sunday', 'QLD', null),
  ('2026-04-06', 'Easter Monday', 'QLD', null),
  ('2026-04-25', 'Anzac Day', 'QLD', null),
  ('2026-05-04', 'Labour Day', 'QLD', null),
  ('2026-08-12', 'Royal Queensland Show (Ekka)', 'BRISBANE', null),
  ('2026-10-05', 'King''s Birthday', 'QLD', null),
  ('2026-12-24', 'Christmas Eve', 'QLD', '6pm to midnight'),
  ('2026-12-25', 'Christmas Day', 'QLD', null),
  ('2026-12-26', 'Boxing Day', 'QLD', null),
  ('2026-12-28', 'Boxing Day (additional day)', 'QLD', null),
  ('2027-01-01', 'New Year''s Day', 'QLD', null),
  ('2027-01-26', 'Australia Day', 'QLD', null),
  ('2027-03-26', 'Good Friday', 'QLD', null),
  ('2027-03-27', 'Day after Good Friday', 'QLD', null),
  ('2027-03-28', 'Easter Sunday', 'QLD', null),
  ('2027-03-29', 'Easter Monday', 'QLD', null),
  ('2027-04-26', 'Anzac Day', 'QLD', null),
  ('2027-05-03', 'Labour Day', 'QLD', null),
  ('2027-08-11', 'Royal Queensland Show (Ekka)', 'BRISBANE', null),
  ('2027-10-04', 'King''s Birthday', 'QLD', null),
  ('2027-12-24', 'Christmas Eve', 'QLD', '6pm to midnight'),
  ('2027-12-25', 'Christmas Day', 'QLD', null),
  ('2027-12-26', 'Boxing Day', 'QLD', null),
  ('2027-12-27', 'Christmas Day (additional day)', 'QLD', null),
  ('2027-12-28', 'Boxing Day (additional day)', 'QLD', null)
on conflict (holiday_date, name) do nothing;
