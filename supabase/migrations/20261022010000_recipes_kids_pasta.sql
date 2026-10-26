-- Kids Pasta: "Fettuccine, penne or gnocchi" becomes three separate ingredients
-- (Fettuccine, Penne, Gnocchi), so each one keeps its own allergens.
-- Data only: no table or function changes. The old line is switched off, not removed.
do $kids$
declare
  v_recipe uuid;
  v_old uuid;
  v_name text;
  v_pos integer := -3;
begin
  select l.recipe_id, l.id into v_recipe, v_old
    from public.recipe_lines l
    join public.recipes r on r.id = l.recipe_id
    join public.recipe_ingredients i on i.id = l.ingredient_id
   where r.location = 'Hawthorne' and r.active and l.active
     and i.name = 'Fettuccine, penne or gnocchi'
   limit 1;
  if v_old is null then return; end if;
  update public.recipe_lines set active = false where id = v_old;
  foreach v_name in array array['Fettuccine', 'Penne', 'Gnocchi'] loop
    perform public.mh_recipe_line_add(v_recipe, 'Hawthorne', v_name, null, v_pos);
    v_pos := v_pos + 1;
  end loop;
  update public.recipes set updated_at = now() where id = v_recipe;
  insert into public.recipe_audit (kind, ref, changed_by, old_value, new_value)
  values ('recipe_split_pasta', v_recipe::text, null,
          jsonb_build_object('line', v_old), jsonb_build_object('lines', array['Fettuccine', 'Penne', 'Gnocchi']));
end $kids$;
