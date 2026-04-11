'use strict';

let supabase = null;
let isSignUp = false;

async function initAuth() {
  // Fetch Supabase config from server
  const res = await fetch('/api/auth/config');
  const config = await res.json();

  if (!config.authEnabled) {
    // Auth not configured — redirect to dashboard
    window.location.href = '/';
    return;
  }

  // Load Supabase JS client from CDN
  await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');

  supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

  // Check if user is already logged in
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    window.location.href = '/';
    return;
  }

  // Handle OAuth redirect callback
  const hash = window.location.hash;
  if (hash && hash.includes('access_token')) {
    const { data: { session: newSession } } = await supabase.auth.getSession();
    if (newSession) {
      window.location.href = '/';
      return;
    }
  }

  setupListeners();
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
