import { ACTIONS, STAGES } from './actions.js';
import { loadEffectiveGrants, loadNames, scopeMatches, describeScope } from './grants.js';
import { audit } from '../services/audit.js';

const summarize = (g, names) => ({ id: g.id, role: g.role, source: g.source, delegator_id: g.delegator_id, scope: describeScope(g, names) });

/**
 * THE decision function (pure). Every check is evaluated (no short-circuit) so the UI can show a full breakdown.
 * Unsure / missing data => DENY with unsure:true.
 * Returns { allowed, reason, matchedGrantId, matchedGrant, unsure, checks[] }.
 */
export function decide({ user, grants, action, job, ctx = {}, names = {} }) {
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass; };
  const out = (allowed, reason, matched = null, unsure = false) => ({
    allowed, reason, matchedGrantId: matched ? matched.id : null, matchedGrant: matched ? summarize(matched, names) : null, unsure, checks,
  });
  const failFirst = (unsure = false) => out(false, checks.find((c) => !c.pass)?.detail ?? 'Denied', null, unsure);

  if (!user) { add('user', false, 'Unknown user'); return failFirst(true); }
  if (!user.active) { add('user', false, `${user.name} is deactivated`); return failFirst(); }
  add('user', true, `${user.name} is active`);

  const def = ACTIONS[action];
  if (!def) { add('action', false, `Unknown action "${action}"`); return failFirst(true); }

  const creating = action === 'upsert' && job && job.id == null && job.stage == null;
  const missing = ['client_id', 'branch_id', 'direction', 'mode', ...(creating ? [] : ['stage'])].filter((k) => job?.[k] == null);
  if (!job || missing.length || (!creating && !STAGES.includes(job.stage))) {
    add('job data', false, `Cannot decide: job data missing or invalid (${job ? missing.join(', ') || `stage "${job.stage}"` : 'no job'}). Denied by default.`);
    return failFirst(true);
  }

  const cn = names.c?.[job.client_id] ?? job.client_id;
  const bn = names.b?.[job.branch_id] ?? job.branch_id;
  const needsFiled = !!def.filedPerm && (job.stage === 'Filed' || (action === 'reopen' && job.cancelled_from_stage === 'Filed'));
  const required = [def.perm, ...(needsFiled ? [def.filedPerm] : [])];

  // 1. does any held role include the permission?
  const withPerm = grants.filter((g) => g.permissions.includes(def.perm));
  add('permission', withPerm.length > 0, withPerm.length
    ? `${user.name} holds ${[...new Set(withPerm.map((g) => g.role))].join(', ')} (includes ${def.perm})`
    : `No role held by ${user.name} includes ${def.perm}`);

  // 2. does a grant with that permission cover this job's client/branch/direction/mode?
  const inScope = withPerm.filter((g) => scopeMatches(g, job));
  if (withPerm.length) {
    add('scope', inScope.length > 0, inScope.length
      ? `${inScope[0].role} grant #${inScope[0].id}${inScope[0].source === 'delegated' ? ` (delegated from user ${inScope[0].delegator_id})` : ''} covers this job (${describeScope(inScope[0], names)})`
      : `Job is ${cn} / ${bn} / ${job.direction} / ${job.mode}, but ${withPerm.map((g) => `${g.role} grant #${g.id} is limited to ${describeScope(g, names)}`).join('; ')}`);
  }

  // 3. filed jobs need the extra Supervisor-level permission
  const qualified = inScope.filter((g) => required.every((p) => g.permissions.includes(p)));
  if (needsFiled && inScope.length) {
    add('filed-authority', qualified.length > 0, qualified.length
      ? `Holds ${def.filedPerm} (Supervisor-level) for this filed job`
      : `This job is/was Filed: ${action} also needs ${def.filedPerm} (Supervisor-level), which none of your grants include`);
  }

  // 4. stage
  if (creating) add('stage', true, 'New job');
  else if (def.blockStages?.includes(job.stage)) add('stage', false, `${action} is not allowed on ${job.stage} jobs`);
  else if (def.from && !def.from.includes(job.stage)) add('stage', false, `Job is ${job.stage}; ${action} needs ${def.from.join(' or ')}`);
  else add('stage', true, `Job is ${job.stage}`);

  // 5. maker != checker (also through delegation)
  let eligible = qualified;
  if (def.makerChecker) {
    if (job.prepared_by === user.id) {
      add('maker-checker', false, 'You prepared this job, so you cannot also check it (maker ≠ checker)');
      eligible = [];
    } else {
      eligible = qualified.filter((g) => !(g.source === 'delegated' && g.delegator_id === job.prepared_by));
      if (qualified.length && !eligible.length) add('maker-checker', false, 'Your authority is delegated by the preparer of this job; delegation cannot bypass maker ≠ checker');
      else add('maker-checker', true, 'You are not the preparer of this job');
    }
  }

  // 6. mandatory reason (only enforced when executing)
  if (def.reason && ctx.enforceReason) {
    add('reason', typeof ctx.reason === 'string' && ctx.reason.trim().length >= 3, ctx.reason?.trim()?.length >= 3 ? 'Reason provided' : `${action} requires a reason (min 3 characters)`);
  }

  const allowed = checks.every((c) => c.pass) && eligible.length > 0;
  if (!allowed) return failFirst();
  const matched = [...eligible].sort((a, b) => (a.source === 'own' ? 0 : 1) - (b.source === 'own' ? 0 : 1))[0];
  return out(true, `Allowed: ${matched.role} grant #${matched.id}${matched.source === 'delegated' ? ` delegated from user ${matched.delegator_id}` : ''} (${describeScope(matched, names)})`, matched);
}

/** DB-backed wrapper. Loads fresh grants every call (no caching); logs 'unsure' denials. */
export async function can(db, userId, action, job, ctx = {}) {
  const { rows: [user] } = await db.query('SELECT id, name, email, user_type, client_id, active FROM users WHERE id = $1', [userId]);
  const grants = user ? await loadEffectiveGrants(db, userId, ctx.at ?? new Date()) : [];
  const names = await loadNames(db);
  const result = decide({ user, grants, action, job, ctx, names });
  if (result.unsure && ctx.logUnsure !== false) {
    await audit(db, { actor: user?.id, action: `unsure:${action}`, job: job?.id, from: job?.stage, decision: 'DENY', reason: result.reason, meta: { unsure: true } });
  }
  return result;
}
