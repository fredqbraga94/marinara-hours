-- Rollback of 20261022010000_recipes_kids_pasta.sql: back to the single
-- "Fettuccine, penne or gnocchi" line on Kids Pasta.
do $kids_down$
declare
  v_recipe uuid;
  v_old uuid;
begin
  select l.recipe_id, l.id into v_recipe, v_old
    from public.recipe_lines l
    join public.recipe_ingredients i on i.id = l.ingredient_id
   where not l.active and i.name = 'Fettuccine, penne or gnocchi'
   order by l.position limit 1;
  if v_old is null then return; end if;
  update public.recipe_lines l set active = false
    from public.recipe_ingredients i
   where i.id = l.ingredient_id and l.recipe_id = v_recipe and l.active and l.position < 0
     and i.name in ('Fettuccine', 'Penne', 'Gnocchi');
  update public.recipe_lines set active = true where id = v_old;
end $kids_down$;
