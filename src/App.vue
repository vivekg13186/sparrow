<script setup>
import TabbedMonacoEditor from "./components/TabbedMonacoEditor.vue";
</script>

<template>
  <main class="app">
     

    <section class="editor-wrap">
      <TabbedMonacoEditor />
    </section>
  </main>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  margin: 0;
  padding: 0;
  background: #181818;
  color: #d4d4d4;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: #1f1f1f;
  border-bottom: 1px solid #0f0f0f;
  flex: 0 0 auto;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand-logo {
  height: 18px;
  width: 18px;
  align-self: center;
}

.brand-name {
  font-weight: 600;
  letter-spacing: 0.4px;
  color: #ffffff;
}

.brand-sub {
  font-size: 12px;
  color: #888;
}

.editor-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
}
</style>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 22px;
  font-weight: 400;
  color-scheme: dark;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  width: 100%;
  background: #181818;
}

button {
  border-radius: 6px;
  border: 1px solid transparent;
  padding: 0.4em 0.8em;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  color: #d4d4d4;
  background-color: #2d2d2d;
  transition: border-color 0.15s, background-color 0.15s;
  cursor: pointer;
}

button:hover {
  border-color: #396cd8;
}
</style>
