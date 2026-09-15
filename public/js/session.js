/**
 * session.js: MOCK sign-in for the prototype.
 *
 * There is no authentication: any email and password "sign in", and the session is just
 * a name + email kept in this browser's localStorage (with an in-memory fallback when
 * storage is unavailable). The REST API is not protected by it.
 */

const SESSION_KEY = 'orderdesk.session';
const REP_KEY = 'orderdesk.repId';
const memory = {};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? memory[key] ?? null : JSON.parse(raw);
  } catch {
    return memory[key] ?? null;
  }
}

function write(key, value) {
  memory[key] = value;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: memory only */ }
}

export const getSession = () => read(SESSION_KEY);

export function signIn(email) {
  const local = email.split('@')[0] || 'demo user';
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
  const session = { email, name, signed_in_at: new Date().toISOString() };
  write(SESSION_KEY, session);
  return session;
}

export const signOut = () => write(SESSION_KEY, null);

/** The rep last viewed on the Sales Rep tab. */
export const getRememberedRep = () => read(REP_KEY);
export const rememberRep = (id) => write(REP_KEY, id);
