-- Rollback of 20261109010000_notes.sql (the Notes lists go away).
drop function if exists public.manager_note_remove(uuid, uuid);
drop function if exists public.manager_note_save(uuid, jsonb);
drop function if exists public.manager_note_list(uuid, text);
drop function if exists public.mh_note_json(public.manager_notes);
drop table if exists public.manager_notes;
