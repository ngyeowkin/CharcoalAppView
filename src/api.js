import { reactive } from 'vue'

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
}

export const auth = reactive({
  token: localStorage.getItem('token'),
  user: load('user'),
  get staff() { return !!this.user?.staff },
  get boss() { return this.user?.role === 'boss' },
})

export function setAuth(token, user) {
  auth.token = token
  auth.user = user
  if (token) {
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(user))
  } else {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
  }
}

let onUnauthorized = () => {}
export function handleUnauthorized(fn) { onUnauthorized = fn }

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data }
}

export async function api(path, { method = 'GET', body, params, form, raw } = {}) {
  const url = new URL(API_URL + path)
  if (params) for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v)

  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: raw ? '*/*' : 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      body: form || (body ? JSON.stringify(body) : undefined),
    })
  } catch {
    throw new ApiError('No connection. Check your internet and try again.', 0)
  }

  if (raw && res.ok) return res.blob()
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (res.status === 401 && path !== '/session') {
    setAuth(null, null)
    onUnauthorized()
  }
  if (!res.ok) throw new ApiError(data?.error || `Something went wrong (${res.status})`, res.status, data)
  return data
}

// multipart upload (photos, bill reading)
export const upload = (path, formData) => api(path, { method: 'POST', form: formData })
// a file such as a full-size photo, as a Blob
export const fetchBlob = (path) => api(path, { raw: true })
