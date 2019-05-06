<template>
  <div id="app">
    <h1>Piping Screen Share</h1>
    <PipingScreenShare />
  </div>
</template>

<script lang="ts">
import { Component, Vue } from 'vue-property-decorator';
import PipingScreenShare from './components/PipingScreenShare.vue';

@Component({
  components: {
    PipingScreenShare,
  },
})
export default class App extends Vue {}
</script>

<style>
#app {
  font-family: 'Avenir', Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
</style>
