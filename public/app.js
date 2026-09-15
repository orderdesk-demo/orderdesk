/**
 * app.js: OrderDesk frontend entry point (vanilla JS, ES modules, no build step).
 *
 * Hash routes:
 *   #/login          mock sign-in (no authentication)
 *   #/leadership     Leadership dashboard
 *   #/rep/:id        Sales Rep dashboard (#/rep opens the last viewed rep, or the first)
 *   #/orders/:id     order detail
 *
 * Talks to the server only through js/api.js. The server stays the source of truth for validation.
 */
import { api } from './js/api.js';
import { initials } from './js/format.js';
import { getSession, signIn, signOut } from './js/session.js';
import { showToast } from './js/ui.js';
import { initOrderForm, openOrderForm } from './js/order-form.js';
import { renderLeadership } from './js/leadership.js';
import { renderRep } from './js/rep.js';
import { renderDetail } from './js/detail.js';

const $ = (selector) => document.querySelector(selector);
const els = {
  login: $('#login-view'),
  loginForm: $('#login-form'),
  loginError: $('#login-error'),
  shell: $('#app-shell'),
  userName: $('#user-name'),
  avatar: $('#user-avatar'),
  logout: $('#logout-btn'),
  tabs: { leadership: $('#tab-leadership'), rep: $('#tab-rep') },
  views: { leadership: $('#leadership-view'), rep: $('#rep-view'), detail: $('#detail-view') },
};

let repsCache = null;
let currentView = null;
let lastListHash = '#/leadership'; // where "Back" from an order detail returns to

/** Shared services the views use (so they never reach into each other). */
const ctx = {
  async getReps() {
    if (!repsCache) repsCache = await api.listReps();
    return repsCache;
  },
  navigate(hash, { replace = false } = {}) {
    if (location.hash === hash) {
      route();
    } else if (replace) {
      location.replace(hash);
    } else {
      location.hash = hash;
    }
  },
  lastListHash: () => lastListHash,
  async openOrderForm(options) {
    try {
      await openOrderForm({ ...options, reps: await ctx.getReps() });
    } catch (err) {
      showToast(`Could not open the order form: ${err.message}`, 'error');
    }
  },
  async deleteOrder(order) {
    if (!confirm(`Delete order #${order.id} for ${order.customer_name}? This cannot be undone.`)) return;
    try {
      await api.deleteOrder(order.id);
      showToast(`Order #${order.id} deleted`);
      if (currentView === 'detail') ctx.navigate(lastListHash);
      else route();
    } catch (err) {
      showToast(err.message, 'error');
    }
  },
};

function showLogin() {
  currentView = 'login';
  els.shell.hidden = true;
  els.login.hidden = false;
  els.loginError.hidden = true;
  document.title = 'Sign in · OrderDesk';
  els.loginForm.elements.email.focus();
}

function showView(name, session) {
  els.login.hidden = true;
  els.shell.hidden = false;
  els.userName.textContent = session.name;
  els.avatar.textContent = initials(session.name);

  for (const [key, view] of Object.entries(els.views)) view.hidden = key !== name;
  // An order detail keeps the tab you came from highlighted
  const activeTab = name === 'detail' ? (lastListHash.startsWith('#/rep') ? 'rep' : 'leadership') : name;
  for (const [key, tab] of Object.entries(els.tabs)) {
    if (key === activeTab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  if (currentView !== name) window.scrollTo(0, 0);
  currentView = name;
}

/** Render whatever the URL hash points at (also used to refresh after writes). */
function route() {
  const hash = location.hash;
  const session = getSession();

  if (!session) {
    if (hash === '#/login') showLogin();
    else ctx.navigate('#/login', { replace: true });
    return;
  }
  if (!hash || hash === '#/' || hash === '#/login') {
    ctx.navigate('#/leadership', { replace: true });
    return;
  }

  let match;
  if (hash === '#/leadership') {
    lastListHash = hash;
    showView('leadership', session);
    renderLeadership(els.views.leadership);
  } else if ((match = hash.match(/^#\/rep(?:\/(\d+))?$/))) {
    lastListHash = hash;
    showView('rep', session);
    renderRep(els.views.rep, ctx, { repId: match[1] ? Number(match[1]) : null });
  } else if ((match = hash.match(/^#\/orders\/(\d+)$/))) {
    showView('detail', session);
    renderDetail(els.views.detail, ctx, Number(match[1]));
  } else {
    ctx.navigate('#/leadership', { replace: true });
  }
}

/* ---------------- Wiring ---------------- */

els.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  // Mock sign-in: any well-formed email works; the password is not checked.
  const email = els.loginForm.elements.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    els.loginError.textContent = 'Enter an email address, e.g. alex.morgan@orderdesk.demo';
    els.loginError.hidden = false;
    return;
  }
  signIn(email);
  repsCache = null;
  ctx.navigate('#/leadership');
});

els.logout.addEventListener('click', () => {
  signOut();
  ctx.navigate('#/login');
});

initOrderForm({
  saved: ({ order, created }) => {
    // A new order placed from a detail page opens that order; otherwise refresh the current view
    if (created && currentView === 'detail') ctx.navigate(`#/orders/${order.id}`);
    else route();
  },
});

window.addEventListener('hashchange', route);
route();
