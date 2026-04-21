'use strict';

let supabase = null;
let isSignUp = false;

async function initAuth() {
  // Always intercept form submit so we never do a native GET on /login
  document.getElementById('email-form')?.addEventListener('submit', (e) => e.preventDefault());

  const res = await fetch('/api/auth/config');
  const config = await res.json();

  if (!config.authEnabled) {
    window.location.href = '/';
    return;
  }

  try {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
    if (!window.supabase?.createClient) throw new Error('Supabase library failed to initialize');
    supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  } catch (err) {
    console.error('[auth] Supabase load failed:', err);
    showError('Could not load authentication library. Please refresh the page.');
    return;
  }

  // Sign-out buttons for pending/rejected states
  document.getElementById('signout-pending')?.addEventListener('click', signOut);
  document.getElementById('signout-rejected')?.addEventListener('click', signOut);

  const params = new URLSearchParams(window.location.search);
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    // Check status — if pending/rejected, stay here and show message
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

  // Handle OAuth redirect callback
  const hash = window.location.hash;
  if (hash && hash.includes('access_token')) {
    const { data: { session: newSession } } = await supabase.auth.getSession();
    if (newSession) { window.location.replace('/'); return; }
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
  if (supabase) await supabase.auth.signOut();
  window.location.replace('/login');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
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
  // Google sign-in
  document.getElementById('google-signin-btn').addEventListener('click', async () => {
    hideError();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/login' }
    });
    if (error) showError(error.message);
  });

  // Email form
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
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + '/login' }
        });
        if (error) {
          showError(error.message);
        } else {
          // Show confirmation message
          document.getElementById('email-form').classList.add('hidden');
          document.getElementById('confirmation-msg').classList.remove('hidden');
          document.querySelector('.auth-toggle').classList.add('hidden');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
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

  // Toggle sign-in / sign-up
  document.getElementById('toggle-btn').addEventListener('click', () => {
    isSignUp = !isSignUp;
    hideError();
    document.getElementById('toggle-text').textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
    document.getElementById('toggle-btn').textContent = isSignUp ? 'Sign In' : 'Sign Up';
    document.getElementById('email-submit-btn').textContent = isSignUp ? 'Sign Up' : 'Sign In';
  });
}

// Listen for auth state changes (handles OAuth redirect)
window.addEventListener('hashchange', async () => {
  if (supabase) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) window.location.href = '/';
  }
});

initAuth();
