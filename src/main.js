import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './engine/engine.css'
import './shell.css'

createApp(App).use(router).mount('#root')
