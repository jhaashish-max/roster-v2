const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly openid email profile';
const SESSION_KEY = 'roster_google_session';

let tokenClient = null;
let resolveAuth = null;
let rejectAuth = null;

export function initGoogleAuth() {
  if (!GOOGLE_CLIENT_ID || typeof google === 'undefined') return;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: (response) => {
      if (response.error) {
        rejectAuth?.(new Error(response.error));
        return;
      }
      const session = {
        access_token: response.access_token,
        expires_at: Math.floor(Date.now() / 1000) + parseInt(response.expires_in || '3600'),
        scope: response.scope,
        user: { email: 'unknown@razorpay.com' },
      };
      fetchUserInfo(response.access_token).then(info => {
        session.user = { email: info.email || 'unknown@razorpay.com' };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        resolveAuth?.(session);
      }).catch(() => {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        resolveAuth?.(session);
      });
    },
  });
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user info');
  return res.json();
}

export function signInWithGoogleDirect() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error('Google Auth not initialized. Check VITE_GOOGLE_CLIENT_ID.'));
      return;
    }
    resolveAuth = resolve;
    rejectAuth = reject;
    tokenClient.requestAccessToken();
  });
}

export function getGoogleSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getGoogleToken() {
  const session = getGoogleSession();
  if (!session?.access_token) return null;
  if (session.expires_at && session.expires_at * 1000 < Date.now()) return null;
  return session.access_token;
}

export function isGoogleLoggedIn() {
  return !!getGoogleToken();
}

export function getGoogleUserEmail() {
  return getGoogleSession()?.user?.email || null;
}

export function googleLogout() {
  const token = getGoogleToken();
  if (token && typeof google !== 'undefined') {
    google.accounts.oauth2.revoke(token, () => {});
  }
  localStorage.removeItem(SESSION_KEY);
}

export function isGoogleTokenExpiringSoon() {
  const session = getGoogleSession();
  if (!session?.expires_at) return false;
  return (session.expires_at * 1000 - Date.now()) < 5 * 60 * 1000;
}

export function isGoogleAuthConfigured() {
  return !!GOOGLE_CLIENT_ID;
}
