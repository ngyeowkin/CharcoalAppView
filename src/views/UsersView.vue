<script setup>
// Team: logins for boss, admin and drivers. Only the boss can add people or set passwords.
import { reactive, ref } from 'vue'
import { api, auth } from '../api'

const users = ref([])
const error = ref('')
const editingId = ref(null)
const form = reactive({})

async function load() {
  try { users.value = await api('/users') } catch (e) { error.value = e.message }
}
load()

function edit(u) {
  editingId.value = u ? u.id : 'new'
  Object.assign(form, { username: '', name: '', role: 'driver', active: true, ...(u || {}), password: '' })
}
async function save() {
  error.value = ''
  const body = { user: { username: form.username, name: form.name, role: form.role, active: form.active, password: form.password } }
  try {
    if (editingId.value === 'new') await api('/users', { method: 'POST', body })
    else await api(`/users/${editingId.value}`, { method: 'PATCH', body })
    editingId.value = null
    load()
  } catch (e) { error.value = e.message }
}
</script>

<template>
  <div class="top">
    <div class="brand"><span class="spark"></span><b>CHARCOAL RUN</b></div>
    <div class="top-right"><RouterLink to="/" class="btn tny-btn">&larr; Back to the app</RouterLink></div>
  </div>
  <div class="wrap team" style="max-width:860px;display:grid;gap:14px">
    <div class="ph">
      <h2>Team</h2>
      <button v-if="auth.boss" class="btn pri" @click="edit(null)">+ Add a login</button>
    </div>
    <div v-if="!auth.boss" class="note">Only the boss can add logins or change passwords.</div>
    <div v-if="error" class="err">{{ error }}</div>

    <form v-if="editingId" class="card pad" style="display:grid;gap:12px" @submit.prevent="save">
      <div class="grid2">
        <label><span class="lbl">Username</span><input v-model="form.username" type="text" autocapitalize="none" required /></label>
        <label><span class="lbl">Name shown in the app</span><input v-model="form.name" type="text" required /></label>
        <label><span class="lbl">Role</span>
          <select v-model="form.role"><option value="driver">Driver</option><option value="admin">Admin</option><option value="boss">Boss</option></select>
        </label>
        <label><span class="lbl">{{ editingId === 'new' ? 'Password' : 'New password — blank keeps the old one' }}</span>
          <input v-model="form.password" type="text" autocomplete="new-password" :required="editingId === 'new'" minlength="6" />
        </label>
        <label class="row small" style="display:flex"><input v-model="form.active" type="checkbox" style="width:auto" /> Can sign in</label>
      </div>
      <div class="tny muted">Changing a password or turning off sign-in logs that person out of every phone.</div>
      <div class="row">
        <button class="btn pri">Save</button>
        <button type="button" class="btn" @click="editingId = null">Cancel</button>
      </div>
    </form>

    <div class="card scroll">
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th></th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id" :class="{ off: !u.active }">
            <td><b>{{ u.name }}</b></td>
            <td class="num">{{ u.username }}</td>
            <td style="text-transform:capitalize">{{ u.role }} <span v-if="!u.active" class="chip c-mute">Off</span></td>
            <td class="ta-r"><button v-if="auth.boss" class="btn tny-btn" @click="edit(u)">Edit</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
