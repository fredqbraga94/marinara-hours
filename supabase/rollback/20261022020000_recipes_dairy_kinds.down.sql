-- Rollback of 20261022020000_recipes_dairy_kinds.sql: every dairy kind goes
-- back to "milk", then the narrower allowed list is restored.
update public.recipe_ingredients
   set allergens = (select coalesce(array_agg(distinct case when a in ('butter','cream','cheese','yoghurt') then 'milk' else a end
                                              order by case when a in ('butter','cream','cheese','yoghurt') then 'milk' else a end), '{}')
                      from unnest(allergens) a),
       updated_at = now()
 where allergens && array['butter','cream','cheese','yoghurt']::text[];
alter table public.recipe_ingredients drop constraint if exists recipe_ingredients_allergens_check;
alter table public.recipe_ingredients add constraint recipe_ingredients_allergens_check check (allergens <@ array[
  'gluten','wheat','milk','egg','soy','peanut','tree_nuts','sesame',
  'fish','crustacean','mollusc','lupin','sulphites']::text[]);
