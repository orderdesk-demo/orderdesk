/**
 * ui.js: toast notifications.
 */

let toastTimer;

export function showToast(message, kind = 'ok') {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.className = `toast show${kind === 'error' ? ' toast-error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}
