'use strict';
// Role / user-management helpers backed by the user_roles table.

const ROLES = ['head_admin', 'super_admin', 'admin', 'team'];
const STATUSES = ['pending', 'active', 'rejected'];

function isAdminRole(role) {
  return role === 'head_admin' || role === 'super_admin' || role === 'admin';
}

// Fetch a single row by user_id. Returns null if not found.
async function getRole(supabase, userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('user_roles')
    .select('user_id, email, role, status')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return null;
  return data;
}

// List all users (join auth.users via admin API + role table).
async function listUsers(supabase) {
  if (!supabase) return [];
  const { data: roles } = await supabase
    .from('user_roles')
    .select('user_id, email, role, status, approved_at, approved_by, created_at')
    .order('created_at', { ascending: false });
  return roles || [];
}

async function setRole(supabase, userId, role, approverEmail) {
  if (!ROLES.includes(role)) throw new Error('Invalid role');
  const { error } = await supabase
    .from('user_roles')
    .update({
      role,
      status: 'active',
      approved_at: new Date().toISOString(),
      approved_by: approverEmail || 'system',
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

async function setStatus(supabase, userId, status, approverEmail) {
  if (!STATUSES.includes(status)) throw new Error('Invalid status');
  const { error } = await supabase
    .from('user_roles')
    .update({
      status,
      approved_at: status === 'active' ? new Date().toISOString() : null,
      approved_by: approverEmail || 'system',
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

// Delete a user entirely (auth + role row via cascade).
async function deleteUser(supabase, userId) {
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
}

// Ensure head_admin rows from env always stay elevated, even if DB drifts.
// Returns { email, role, status } the caller should use, falling back to the
// existing DB row if present. Does NOT modify DB — that's the boot job.
function effectiveRoleForEmail(dbRow, email, envAdmins) {
  const e = (email || '').toLowerCase();
  if (envAdmins.has(e)) {
    return { email: e, role: 'admin', status: 'active' };
  }
  if (dbRow) return dbRow;
  return { email: e, role: 'team', status: 'pending' };
}

module.exports = {
  ROLES, STATUSES, isAdminRole,
  getRole, listUsers, setRole, setStatus, deleteUser,
  effectiveRoleForEmail
};
