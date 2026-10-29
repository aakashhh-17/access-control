# DEMO (about 5 minutes)

Setup once: `npm run seed` (resets data), backend `npm run dev`, frontend `npm run dev`, open http://localhost:5173. Password for everyone: `Demo@1234`. Use the **header dropdown** to switch people.

**0:00 – Sign in as Anita Admin (`admin`).** "Management wanted strict where it matters, easy day to day." Jobs tab → All I can see → search `DEMO-CONFLICT` → open it.

**0:30 – "Why can she do this and he can't?"** On `NFPL-DEMO-CONFLICT` (Prepared by Dev Dual), in the Why panel choose action `check`, Person A = Dev Dual, Person B = Charu Checker-All → Compare. Dev is *qualified* (permission ✓, scope ✓) but fails maker-checker; Charu is allowed. Note the buttons on this page: Admin has no prepare/check/file at all (each disabled button explains why).

**1:30 – Narrow and wide grants.** Search `EXPORT-NARROW`: action `check`, Chirag Checker-Narrow vs Meera Maker-All. Chirag is blocked ("limited to … imports only"); Meera is allowed (she is Checker for Acme). Then `DELTA-PREP`: Meera is blocked (no Checker grant for Delta), Gita Grant-Changed is allowed.

**2:15 – Absent owner.** Switch to Carla Cover (`cover.deleg`). Waiting tab includes Om's `NFPL-DEMO-ABSENT-1`. Open it: Prepare is enabled, "delegated from user …". Click Prepare. Point out the badge count equals the list total (same query). Switch to Bina Branch-Mumbai: she can reassign a job to someone else with a reason.

**3:00 – Filed jobs.** As Bina, open `NFPL-DEMO-FILED`: Cancel is disabled ("also needs job.cancel_filed (Supervisor-level)"). Switch to Sunil Supervisor: Cancel is enabled but demands a reason. Cancel it with a reason, then see it in History.

**3:45 – History and "who could have changed it on the 3rd?".** As Anita, open `NFPL-DEMO-REVOKED-DONE`. History shows Gita checked it under a grant that was later revoked. In "Who could have changed this job on…" pick the date 15 days ago: Gita is listed (old global Checker grant, "since revoked") and appears under "Actually did". Pick today: she is gone.

**4:30 – Admin can't promote herself.** Grants tab → "Try granting myself Maker" → "Blocked and logged". Mention the database `CHECK` as a second line of defence, and that the attempt is already in the audit trail.

**4:50 – Client view and close.** Switch to Alok (`client.acme`): only Acme jobs, no internal notes, every action disabled, Delta jobs return 404. Close with: `npm test` (60 tests), `npm run seed:scale` (200k jobs, waiting page in single-digit to ~35 ms), and DESIGN.md's 14 answers.

Reset between runs with `npm run seed`.
