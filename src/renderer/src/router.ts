import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  // file:// 加载下必须用 hash 模式
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', name: 'library', component: () => import('./views/LibraryView.vue') },
    { path: '/search', name: 'search', component: () => import('./views/SearchView.vue') },
    { path: '/online', name: 'online', component: () => import('./views/OnlineView.vue') },
    { path: '/tools', name: 'tools', component: () => import('./views/ToolsView.vue') },
    { path: '/reader/:id', name: 'reader', component: () => import('./views/ReaderView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') }
  ]
})

export default router
