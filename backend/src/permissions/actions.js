// Action catalogue. Which PERMISSION an action needs is code (stable workflow);
// which ROLE carries that permission is data (roles table).
export const STAGES = ['Confirmed', 'Prepared', 'Checked', 'Filed', 'Cancelled', 'Reopened'];

export const ACTIONS = {
  prepare:   { perm: 'job.prepare', from: ['Confirmed', 'Reopened'], to: 'Prepared' },
  check:     { perm: 'job.check', from: ['Prepared'], to: 'Checked', makerChecker: true },
  file:      { perm: 'job.file', from: ['Checked'], to: 'Filed' },
  // Filed jobs need the extra *_filed permission (Supervisor-level) on top of the base one.
  cancel:    { perm: 'job.cancel', filedPerm: 'job.cancel_filed', from: ['Confirmed', 'Prepared', 'Checked', 'Filed', 'Reopened'], to: 'Cancelled', reason: true },
  reopen:    { perm: 'job.reopen', filedPerm: 'job.reopen_filed', from: ['Filed', 'Cancelled'], to: 'Reopened', reason: true },
  admin_fix: { perm: 'job.admin_fix', blockStages: ['Filed'], reason: true },
  reassign:  { perm: 'job.reassign', blockStages: ['Filed', 'Cancelled'], reason: true },
  upsert:    { perm: 'job.create_update', blockStages: ['Filed'] },   // parser
};

export const PUBLIC_ACTIONS = ['prepare', 'check', 'file', 'cancel', 'reopen', 'admin_fix'];
// "Jobs waiting for me" = jobs where one of these stage actions is currently allowed.
export const WAITING_ACTIONS = ['prepare', 'check', 'file'];
