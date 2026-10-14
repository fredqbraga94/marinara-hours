# Work review — 2026-10-12

Production was inspected read-only. No deploy, merge, migration, real login,
session mutation, PIN change or historical-data modification was performed.

## Verified state

- Main: `8dc582479b51559fd5b08f82eafd1a013a0c2242`; PRs 1 and 2 merged.
- PR 5 inspected at `e49d30f602d1294ab9d71f1498b59b224d78f6a6`, open/draft.
- PR 3: `0c4f3b9ae8f1d26a652f473b6408219c1c3922c9`, open/draft.
- PR 4: `9f9f3f2885db7e3f2a7f1f78ed40fe3ffffce505`, open/draft, stacked on PR 3.
- Supabase principal function: version 36, JWT verification enabled.
- Retired function sources return 410 (OPTIONS on smart-responder/staging returns 200).
  Their platform status remains ACTIVE; they are retired by their source code.
- Migration history contains only `20261012003727 add_manager_clock_out_staff`.
  Catalog inspection confirms pin_match_count, pin_attempt_reserve,
  login_with_pin_v2 and manager_edit_shift are absent.
- All nine production function fingerprints in tests/integration/run.mjs match
  fresh catalog reads. No staff rows or PIN hashes were retrieved.
- Downloaded v36 source exactly matches tests/edge/baseline-v36.ts:
  SHA256 `e7275228691b8076cbf74680b9641fdf45f3c4369463537d194e5d5d5091d0fb`.
- Original HEAD Actions run 38221460138 concluded success.

## PR 5 correction and evidence

The observation rejection handler could itself throw if console.warn failed.
The harness settle() uses Promise.allSettled and discarded that rejection;
thus a successful login test did not prove the background promise was safe.

Added a regression asserting all captured background promises fulfill under
a failing logger. It failed on the original source and passes after guarding
the observation error logger. The synchronous fallback logger is also guarded.
The complete API suite was executed: 32 passed, zero failures.

Local database/integration execution could not start: PostgreSQL binaries are
absent. Package installation failed on OS identity permissions. This is an
environment blocker, not a successful database test. CI must pass on the new
commit before release. E2E initially failed to start because the original test
hardcodes a Chromium installation path; browser provisioning is being checked.

## Remaining release gates

PR 5 remains observe-only and does NOT fix incorrect-PIN throttling.
Do not present it as a security remediation. Without its optional migration,
shared-PIN detection is unavailable and logs that fact on successful login.
IP-derived tags identify networks, not devices, and mocked header precedence
does not establish which headers the real ingress sanitizes.
The timeout stops waiting but does not cancel the underlying RPC.

Before release: verify fresh CI on the correction, complete browser validation,
re-download production and re-check the full rollback hash, and obtain explicit
owner approval for this exact Edge source. Deploy only marinara-api-v2, preserve
verify_jwt=true, do not run database migrations. Keep the original source and
deployment settings. If login/clock errors increase, redeploy baseline-v36.ts
with the same settings; do not revoke sessions or alter data. A rollback creates
a new deployment version containing the old source; it does not reset version
number to 36. No release approval is requested while these gates remain open.

## PR 3 risks requiring isolated validation

- The global 40-attempt ceiling allows one attacker to lock out the venue.
- Per-IP limiting groups staff behind shared Wi-Fi; it is not per-device.
- Rejecting duplicate PINs changes legitimate login behavior. No real PINs
  should be changed or enumerated to resolve this automatically.
- Release/reset operations need concurrency tests with both good and bad logins.
- A safe replacement needs a trusted ingress identity and an explicit recovery
  path; merely switching empty results to 401 restores the old global lockout
  and is not an operationally safe complete fix.

## PR 4 incremental review

Prepare separate changes for audit retention, atomic audited manager mutations,
overlap serialization, duplicate-break handling, and least SQL privileges.
The proposed edit locks only its target shift before checking overlaps: two
different shifts for one staff member can both pass the check concurrently.
Manual creation must participate in the same serialization strategy.
Changing ON DELETE CASCADE to SET NULL preserves audit rows, but restoring
CASCADE is not a safe default rollback because it reintroduces history loss.
Do not apply the combined PR or its suggested rollback without review and
isolated concurrency/permission tests. These changes are not implemented here.
