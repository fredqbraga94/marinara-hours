# Retired Edge Functions — exact backups for rollback

Both functions were replaced by a 410 "retired" stub on 2026-10-12 (owner-approved).
These files are the exact code that was deployed before, so either can be restored.

| Function | id | Version before | Entrypoint | verify_jwt | Code sha256 (first 16) |
|---|---|---|---|---|---|
| smart-responder (name "marinara-api") | ec8e228a-8df5-4ada-ae1c-2264764b79bd | 2 | index.ts | false | c88fb6e2c7faa69f |
| marinara-api-v2-staging | 2b9adcfa-da0c-4f9c-ac86-095491ceb7ae | 1 | Index.ts | true | e7275228691b8076 |

Rollback: redeploy the file above to the same slug with the same entrypoint and
verify_jwt value (Supabase dashboard -> Edge Functions, or the deploy tool).
Neither function is used by the app (index.html only calls marinara-api-v2).

Why smart-responder was retired: public (no JWT), used the service role, and its
`login` action confirmed whether a PIN was valid with no attempt limit.
