<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, setAuth } from '../api'

const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const res = await api('/session', { method: 'POST', body: { username: username.value, password: password.value } })
    setAuth(res.token, res.user)
    router.replace(route.query.next || '/')
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="card login-card" @submit.prevent="submit">
      <div class="brand"><span class="spark"></span><b>CHARCOAL RUN</b></div>
      <label><span class="lbl">Username</span>
        <input v-model="username" type="text" autocomplete="username" autocapitalize="none" required />
      </label>
      <label><span class="lbl">Password</span>
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="error" class="err">{{ error }}</p>
      <button class="btn pri big" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      <p class="tny muted" style="text-align:center;margin:0">You stay signed in on this phone for 7 days.</p>
    </form>
  </div>
</template>
