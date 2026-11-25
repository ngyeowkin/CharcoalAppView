import { createRouter, createWebHistory } from 'vue-router'
import { auth, handleUnauthorized } from './api'

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/team', component: () => import('./views/UsersView.vue'), meta: { staff: true } },
  { path: '/', component: () => import('./views/RunApp.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  if (!to.meta.public && !auth.token) return { path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} }
  if (to.meta.staff && !auth.staff) return '/'
})

handleUnauthorized(() => router.push('/login'))

export default router
