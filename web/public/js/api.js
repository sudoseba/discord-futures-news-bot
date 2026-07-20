// Tiny fetch wrapper. On 401 it bounces to /login. Throws on non-2xx.
export async function api(path, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-json */ }
  if (!res.ok) {
    throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status, data });
  }
  return data;
}

export const getJSON = (path) => api(path);
export const postJSON = (path, body) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
