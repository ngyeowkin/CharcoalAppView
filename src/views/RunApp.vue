<script setup>
// Hosts the Charcoal Run screens (src/engine). Vue handles sign-in, the top bar and
// the Team page; the engine draws the driver and office screens into #app.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, auth, fetchBlob, setAuth, upload } from '../api'
import { createEngine } from '../engine/engine.js'

const router = useRouter()
const status = ref('ok')
let engine

onMounted(() => {
  engine = createEngine({
    api, upload, fetchBlob,
    user: { name: auth.user.name, role: auth.user.role, staff: auth.staff },
    onStatus: (s) => { status.value = s },
  })
  engine.start()
})
onBeforeUnmount(() => engine?.stop())

async function logout() {
  try { await api('/session', { method: 'DELETE' }) } catch {}
  setAuth(null, null)
  router.push('/login')
}
</script>

<template>
  <div class="top">
    <div class="brand"><span class="spark"></span><b>CHARCOAL RUN</b></div>
    <span v-if="status === 'offline'" class="demo" title="Changes you make are retried when the connection is back">Offline</span>
    <div class="top-right">
      <div v-if="auth.staff" class="seg" role="tablist">
        <button role="tab" id="tabDriver" aria-selected="false">Driver</button>
        <button role="tab" id="tabAdmin" aria-selected="true">Office</button>
      </div>
      <RouterLink v-if="auth.staff" to="/team" class="btn tny-btn">Team</RouterLink>
      <span class="who-me">{{ auth.user?.name }}</span>
      <button class="btn tny-btn" @click="logout">Sign out</button>
    </div>
  </div>
  <div class="wrap" id="app"></div>
  <div id="bar"></div>
  <div class="toast" id="toast"></div>
</template>
