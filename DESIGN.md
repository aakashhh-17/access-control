# DESIGN

## The model in one paragraph

A **grant** says "this user holds this role over this slice": `(user, role, client?, branch?, direction?, mode?, valid_from, valid_to?)`, where `NULL` means "all". A **role** is a row of data listing permissions (`job.prepare`, `job.check`, …). A **job** has a client, branch, direction, mode and stage. One function, `can(user, action, job)`, combines them: the stage must allow the action, some grant held *right now* (own or delegated) must carry the permission and cover the job's slice, and the person-level rules (maker ≠ checker, Supervisor-level for filed jobs, reason required) must pass. Every decision, allowed or denied, goes to an append-only audit log.

## Key decisions and trade-offs

- **Visibility and action are separate.** `job.view` is scoped by grants; acting needs a specific permission. Client users have `job.view` but not `job.view_internal`, so they never receive internal notes (the field is removed server-side, not hidden in the UI). Out-of-scope jobs return 404, so existence isn't leaked.
- **One grant shape, no special cases.** "Maker for every client, Checker for a few" is three rows. "Checker for Acme at Mumbai, imports only" is one row. The cost is more rows per person and a query that ORs across a user's grants; people hold 1–3 grants, so that is cheap.
- **Roles are data.** Which *permission* an action needs is code (the workflow is stable). Which *role carries* a permission is a row in `roles`, so a new role is an `INSERT`, not a deploy. Trade-off: renaming a permission is still a code change.
- **Evaluate at action time, never cache.** Each request re-reads the user and grants; actions lock the job row and read grants inside the same transaction. Revoking therefore applies on the next request, including to a JWT issued earlier. Trade-off: a few small queries per request, which is fine at this size.
- **The decision function is pure, with a SQL mirror.** `decide()` is a pure function over loaded grants (testable, returns every check). The list and count use `waitingWhere()`, which compiles the same rules to SQL. Two implementations is a real risk of drift; a test walks every job for 11 users and asserts the SQL result equals `decide()`.
- **Append-only by the database, not by convention.** Triggers reject `UPDATE`/`DELETE` on `audit_log` and `DELETE` on `grants`, forbid rescoping a grant, and forbid un-revoking one. A `CHECK` rejects self-granting even if the application layer had a bug.
- **Delegation stores no permissions.** It is `(from, to, window, optional scope)`. At decision time the delegate receives the delegator's *current* grants, narrowed by the scope, minus `grants.manage` and `job.admin_fix`. So it can never exceed the delegator, and it shrinks automatically when the delegator loses a grant.
- **JWT only proves identity.** 8-hour expiry, no refresh tokens. Deactivating a user or revoking a grant does not wait for the token to expire.

## The 14 questions

1. **Should everyone see everything?** No. Staff see jobs matching a grant that includes `job.view` (all staff roles do); client users see only their own client's jobs. Seeing is separate from acting: a Delhi maker cannot even open a Mumbai job, and a Checker cannot file.
2. **Maker for every client but Checker for a few; Checker for one client at one branch, imports only?** Plain grants with NULLs. Meera: Maker (all) + Checker (Acme) + Checker (Bharat). Chirag: Checker (client=Acme, branch=Mumbai, direction=import). Denials name the exact mismatch ("limited to … imports only").
3. **Preparer also qualified to approve?** Qualified is not enough: `prepared_by = user` denies `check` with an explicit reason. It also applies through delegation: a delegate cannot use authority delegated *by the preparer*. Only maker ≠ checker is enforced (Filer vs Checker is not).
4. **Responsible person absent?** Two tools. (a) A delegation (by the person or a manager) hands their current grants to a cover for a window: the cover sees and can act on those jobs. (b) A manager reassigns a job's responsible user (reason required, audited). The responsible user is a hint (`mine` flag), not a lock, so anyone qualified can act and work doesn't stall.
5. **Halfway through when responsibilities change?** Grants are checked at action time, so a person who lost the grant can no longer act, and the job drops out of their queue (and out of their view if the revoked grant was their only view). Their earlier actions stay in history under the grant that authorized them. The job simply waits for someone currently qualified.
6. **Cancel a filed job or reopen a closed one?** `job.cancel_filed` / `job.reopen_filed`, carried only by Supervisor, plus a mandatory reason, recorded in the audit log. Unfiled jobs can be cancelled/reopened by BranchManager (own branch) or Supervisor. A job that was cancelled *from Filed* needs the Supervisor-level permission again to reopen. Reopening clears prepared/checked/filed so the job goes through maker/checker afresh; the old values stay in history.
7. **Client's own employee following shipments?** `ClientUser` role scoped to their client: read-only, no actions, no internal notes, history reduced to stage movements (no people or reasons).
8. **Admin fixing a stuck job? Admin making themselves stronger?** `job.admin_fix` resets a stuck job to Confirmed/Prepared/Checked or changes its responsible user, requires a reason, is always audited with before/after, and is refused on Filed jobs (a Supervisor must reopen first). Admin holds no prepare/check/file permission. A grant to oneself is blocked in the API, logged as a DENY, and rejected again by a database constraint. A granter can only give roles in their `grantable_roles` and only over a scope their own grant covers; Admin cannot create Admins.
9. **Automated parser overnight?** A service-account user with the `Parser` role (`job.create_update` only). It can create and update job details but cannot change stage, cannot see jobs, and cannot touch Filed jobs. Moving a job requires permission on both the old and the new scope. Its writes are audited with the parser as actor.
10. **"Why can she do this and he can't?"** `GET /jobs/:id/can?action=&user_id=` runs the same `decide()` and returns every check (user, permission, scope, filed-authority, stage, maker-checker, reason) with a plain-language detail. The Why panel puts two people side by side. Managers can ask about anyone; others only about themselves.
11. **"Who could have changed this job on the 3rd?"** `GET /jobs/:id/who-could-have?date=`: grants are never deleted, only revoked or expired, so we reconstruct everyone who held a mutating permission covering the job at any moment that (UTC) day, including delegates, and list who *actually* acted from the audit log next to it.
12. **New kind of role next quarter, engineering busy?** Insert a row into `roles` with a permission list (and `grantable_roles`), then grant it. No deploy, as long as it reuses existing permissions.
13. **Waiting count matches what the person can do?** The badge, the list's `total`, and the list itself come from one SQL builder that encodes the same rules as `decide()`, including maker ≠ checker and delegation. A test checks this per user, job by job.
14. **When the system is unsure?** Deny. Missing job fields, unknown action, unknown user or invalid stage give `allowed: false, unsure: true`, a reason ending "Denied by default", and an `unsure:<action>` audit row.

## Assumptions (the brief was silent)

- `Reopened` behaves like `Confirmed` (needs a fresh prepare).
- "Waiting for me" means prepare/check/file only (not cancel/reopen), and lists every job the user is currently allowed to act on.
- `admin_fix` cannot reach Filed jobs; Admin cannot work jobs; the responsible user is cleared whenever the stage changes.
- Every staff role includes `job.view` and `job.view_internal`; `ClientUser` has `job.view` only.
- Delegation is direct only (not chained) and excludes admin powers; a manager or the delegator can create it.
- A BranchManager's grant powers are limited to their own branch and to Maker/Checker/Filer.
- `who-could-have` uses a UTC day. **Limitation:** it uses each role's *current* permission list, so editing a role's permissions rewrites how the past is reconstructed; versioning the `roles` table would fix that. Delegation windows are matched to the day, not to the minute.
- Deactivating a user is immediate (checked per request); history keeps them.

## Cut scope

Refresh tokens, SSO, email verification and password reset (brief said minimal); realtime updates (list is fetched on demand); caching (it would fight "revocations are immediate" and the queries are fast); delegation UI (API only); grant edit (revoke and re-issue instead, which keeps history clean); keyset pagination (offset is fine at this size); role-permission versioning (above); rate limiting; fancy UI.
