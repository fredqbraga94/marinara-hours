-- Allergens: the kitchen can mark what a dairy ingredient really is (milk,
-- butter, cream, cheese, yoghurt); the app shows them together as "Dairy".
-- Widens the allowed list (nothing existing becomes invalid) and turns the
-- pre-marked "milk" on cheeses, cream and butter into the exact kind. Only
-- ingredients nobody has checked yet and that still carry exactly the
-- pre-marked value are changed, so anything set by hand stays as it is.
alter table public.recipe_ingredients drop constraint if exists recipe_ingredients_allergens_check;
alter table public.recipe_ingredients add constraint recipe_ingredients_allergens_check check (allergens <@ array[
  'gluten','wheat','milk','butter','cream','cheese','yoghurt','egg','soy','peanut','tree_nuts','sesame',
  'fish','crustacean','mollusc','lupin','sulphites']::text[]);

update public.recipe_ingredients i set allergens = m.a, updated_at = now()
  from (values
    ('Mozzarella', array['milk'], array['cheese']), ('Parmesan', array['milk'], array['cheese']),
    ('Fetta', array['milk'], array['cheese']), ('Bocconcini', array['milk'], array['cheese']),
    ('Cream', array['milk'], array['cream']),
    ('Butter', array['milk'], array['butter']), ('Garlic butter', array['milk'], array['butter']),
    ('Spinach & ricotta ravioli', array['gluten','milk','wheat'], array['cheese','gluten','wheat'])
  ) as m(n, was, a)
 where i.location = 'Hawthorne' and i.name = m.n and not i.checked and i.allergens = m.was;
