'use strict';

// NOTE: the vendor UMD bundle sets window.supabase as a var, so we MUST NOT
// declare a top-level variable also named "supabase" — it would clash and throw
// "SyntaxError: Identifier 'supabase' has already been declared".
let supabaseClient = null;
let isSignUp = false;

// Belt-and-suspenders: intercept the form's native submit BEFORE initAuth's
// async work runs. Any later failure (Supabase library missing, network error,
// etc.) won't cause the browser to do a native GET and reload the page.
(function installFormGuard() {
  const form = document.getElementById('email-form');
  if (form) form.addEventListener('submit', (e) => e.preventDefault(), true);
})();

async function initAuth() {
  console.log('[auth] initAuth; supabase lib present:', !!window.supabase?.createClient);

  const res = await fetch('/api/auth/config');
  const config = await res.json();

  if (!config.authEnabled) {
    window.location.href = '/';
    return;
  }

  if (!window.supabase?.createClient) {
    console.error('[auth] Supabase library not loaded');
    showError('Authentication library failed to load. Please refresh the page.');
    return;
  }
  if (!config.supabaseAnonKey) {
    console.error('[auth] Supabase anon key missing from server config');
    showError('Auth configuration error — contact the administrator.');
    return;
  }
  try {
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  } catch (err) {
    console.error('[auth] createClient failed:', err);
    showError('Auth configuration error — contact the administrator.');
    return;
  }

  // Sign-out buttons for pending/rejected states
  document.getElementById('signout-pending')?.addEventListener('click', signOut);
  document.getElementById('signout-rejected')?.addEventListener('click', signOut);

  const params = new URLSearchParams(window.location.search);
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    const me = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${session.access_token}` } }).then(r => r.json()).catch(() => ({}));
    if (me.status === 'pending' || params.has('pending')) {
      showStatusMessage('pending');
      setupListeners();
      return;
    }
    if (me.status === 'rejected' || params.has('rejected')) {
      showStatusMessage('rejected');
      setupListeners();
      return;
    }
    if (me.status === 'active') {
      window.location.replace('/');
      return;
    }
  }

  setupListeners();
}

function showStatusMessage(which) {
  document.getElementById('email-form')?.classList.add('hidden');
  document.getElementById('google-signin-btn')?.classList.add('hidden');
  document.querySelector('.divider')?.classList.add('hidden');
  document.querySelector('.auth-toggle')?.classList.add('hidden');
  document.getElementById(which === 'pending' ? 'status-pending' : 'status-rejected')?.classList.remove('hidden');
}

async function signOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  window.location.replace('/login');
}

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  document.getElementById('auth-error').classList.add('hidden');
}

function setupListeners() {
  document.getElementById('email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const email = document.getElementById('email-input').value.trim();
    const password = document.getElementById('password-input').value;
    const btn = document.getElementById('email-submit-btn');

    if (!email || !password) return showError('Please fill in all fields');
    if (password.length < 6) return showError('Password must be at least 6 characters');

    btn.disabled = true;
    btn.textContent = isSignUp ? 'Signing up...' : 'Signing in...';

    try {
      if (isSignUp) {
        const { error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + '/login' }
        });
        if (error) {
          showError(error.message);
        } else {
          document.getElementById('email-form').classList.add('hidden');
          document.getElementById('confirmation-msg').classList.remove('hidden');
          document.querySelector('.auth-toggle').classList.add('hidden');
        }
      } else {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
          showError(error.message);
        } else {
          window.location.href = '/';
        }
      }
    } catch (err) {
      showError('An unexpected error occurred. Please try again.');
    }

    btn.disabled = false;
    btn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
  });

  document.getElementById('toggle-btn').addEventListener('click', () => {
    isSignUp = !isSignUp;
    hideError();
    document.getElementById('toggle-text').textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
    document.getElementById('toggle-btn').textContent = isSignUp ? 'Sign In' : 'Sign Up';
    document.getElementById('email-submit-btn').textContent = isSignUp ? 'Sign Up' : 'Sign In';
  });
}

initAuth();
