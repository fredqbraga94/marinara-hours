-- Rollback of 20261021040000_push.sql
-- Removes phone notifications (the subscribed phones simply stop receiving).
drop function if exists public.mh_push_result(uuid, boolean, boolean, text);
drop function if exists public.mh_push_targets(text, text);
drop function if exists public.mh_push_for_staff(uuid);
drop function if exists public.manager_push_remove(uuid, uuid);
drop function if exists public.manager_push_list(uuid);
drop function if exists public.manager_push_unsubscribe(uuid, text);
drop function if exists public.manager_push_subscribe(uuid, text, text, text, text);
drop function if exists public.mh_push_json(public.push_subscriptions);
drop table if exists public.push_subscriptions;
