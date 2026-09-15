/**
 * api.js: the frontend's only way to talk to the server (REST over fetch()).
 */

/** fetch() wrapper: parses JSON, throws an Error carrying the API's `errors` list and HTTP status. */
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Always read the body, even an empty 204: leaving it unread makes Chrome log the request as aborted.
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const errors = (data && data.errors) || [`Request failed (${res.status})`];
    const err = new Error(errors.join('; '));
    err.errors = errors;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** ?a=1&b=2 from an object, skipping empty values. */
function query(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const qs = new URLSearchParams(entries).toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  listOrders: (filters = {}) => request('GET', `/api/orders${query(filters)}`),
  getOrder: (id) => request('GET', `/api/orders/${id}`),
  createOrder: (data) => request('POST', '/api/orders', data),
  updateOrder: (id, data) => request('PUT', `/api/orders/${id}`, data),
  deleteOrder: (id) => request('DELETE', `/api/orders/${id}`),
  listReps: () => request('GET', '/api/reps'),
  listProducts: () => request('GET', '/api/products'),
  leadership: (days) => request('GET', `/api/dashboard/leadership${query({ days })}`),
  repDashboard: (id) => request('GET', `/api/dashboard/rep/${id}`),
  insights: () => request('GET', '/api/insights'),
};
