/** Append-only audit writer. `db` may be the pool or a transaction client. */
export async function audit(db, o) {
  const { rows: [r] } = await db.query(
    `INSERT INTO audit_log(actor_id, action, job_id, from_stage, to_stage, decision, reason, matched_grant_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [o.actor ?? null, o.action, o.job ?? null, o.from ?? null, o.to ?? null, o.decision ?? 'ALLOW', o.reason ?? null, o.grant ?? null, JSON.stringify(o.meta ?? {})]);
  return r.id;
}
