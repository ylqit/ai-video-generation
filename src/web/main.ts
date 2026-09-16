import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import './workspace.css';
import { dialogFocus } from './dialog-focus';
createApp(App).directive('dialog-focus', dialogFocus).mount('#app');
