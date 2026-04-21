'use strict';
// Server-side migrations run on boot. Idempotent — safe to re-run.

async function runMigrations(supabase) {
  if (!supabase) return;

  // We need direct SQL access; supabase-js doesn't expose raw SQL, so we use
  // the `pg` library against the database URL. But since we don't have that,
  // we do everything that CAN be done via the data API, and the rest via a
  // series of small RPC-like upserts. The table + trigger must already exist
  // (one-time manual setup). Here we just ensure rows/grants are healthy.

  // Smoke-test that user_roles is queryable.
  const { error } = await supabase.from('user_roles').select('user_id').limit(1);
  if (error) {
    console.warn('[migrations] user_roles query failed:', error.message);
    console.warn('[migrations] Run this SQL in Supabase SQL editor once:');
    console.warn(BOOTSTRAP_SQL);
  } else {
    console.log('[migrations] user_roles table OK');
  }
}

const BOOTSTRAP_SQL = `
-- Run once in Supabase SQL editor:
create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'team' check (role in ('head_admin','super_admin','admin','team')),
  status text not null default 'pending' check (status in ('pending','active','rejected')),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.user_roles disable row level security;
grant all on public.user_roles to supabase_auth_admin, postgres, service_role, authenticated;

create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $func$
begin
  insert into public.user_roles (user_id, email, role, status)
  values (new.id, new.email, 'team', 'pending')
  on conflict (user_id) do nothing;
  return new;
exception when others then
  return new;
end;
$func$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
`;

// Bootstrap the head admin and super admin from env vars. Creates accounts
// if they don't exist, upserts their role, and marks them active.
async function bootstrapAdmins(supabase) {
  if (!supabase) return;

  const headAdmin = process.env.HEAD_ADMIN_EMAIL?.toLowerCase().trim();
  const headPassword = process.env.HEAD_ADMIN_PASSWORD;
  const superAdmin = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim();

  if (headAdmin && headPassword) {
    await ensureUser(supabase, headAdmin, headPassword, 'head_admin');
  }
  if (superAdmin) {
    // Send invitation; they'll set their own password.
    await ensureInvite(supabase, superAdmin, 'super_admin');
  }
}

async function ensureUser(supabase, email, password, role) {
  try {
    // Try to find existing user by email.
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    let user = (list?.users || []).find(u => (u.email || '').toLowerCase() === email);

    if (!user) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });
      if (error) { console.warn('[migrations] createUser failed:', error.message); return; }
      user = data.user;
      console.log('[migrations] Created', role, email);
    } else {
      // Reset password to the configured one so the doc-stated creds always work.
      await supabase.auth.admin.updateUserById(user.id, { password, email_confirm: true });
    }

    // Upsert role row as active.
    const { error: upErr } = await supabase.from('user_roles').upsert({
      user_id: user.id,
      email,
      role,
      status: 'active',
      approved_at: new Date().toISOString(),
      approved_by: 'system'
    }, { onConflict: 'user_id' });
    if (upErr) console.warn('[migrations] user_roles upsert failed:', upErr.message);
    else console.log('[migrations] Role set:', email, '→', role);
  } catch (e) {
    console.warn('[migrations] ensureUser error:', e.message);
  }
}

async function ensureInvite(supabase, email, role) {
  try {
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    let user = (list?.users || []).find(u => (u.email || '').toLowerCase() === email);

    if (!user) {
      const redirectTo = process.env.DASHBOARD_URL
        ? `${process.env.DASHBOARD_URL}/login`
        : undefined;
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error) { console.warn('[migrations] invite failed:', error.message); return; }
      user = data.user;
      console.log('[migrations] Invited', role, email);
    }

    const { error: upErr } = await supabase.from('user_roles').upsert({
      user_id: user.id,
      email,
      role,
      status: 'active',
      approved_at: new Date().toISOString(),
      approved_by: 'system'
    }, { onConflict: 'user_id' });
    if (upErr) console.warn('[migrations] user_roles upsert failed:', upErr.message);
    else console.log('[migrations] Role set:', email, '→', role);
  } catch (e) {
    console.warn('[migrations] ensureInvite error:', e.message);
  }
}

module.exports = { runMigrations, bootstrapAdmins, BOOTSTRAP_SQL };
