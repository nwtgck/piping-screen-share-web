// (from: https://vuetifyjs.com/en/framework/icons#icons)
import 'material-design-icons-iconfont/dist/material-design-icons.css';
import Vue from 'vue';
import App from './App.vue';
import './registerServiceWorker';
import VueCompositionAPI from '@vue/composition-api'
import Vuetify from 'vuetify';
import vuetify from './plugins/vuetify';
import 'vuetify/dist/vuetify.min.css';

Vue.config.productionTip = false;

Vue.use(VueCompositionAPI);
Vue.use(Vuetify);

new Vue({
  vuetify,
  render: (h) => h(App),
}).$mount('#app');
