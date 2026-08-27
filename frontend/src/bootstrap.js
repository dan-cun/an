const featureRoute = /^\/(dashboard|workbench|audit|models)(?:\/|$)/.test(window.location.pathname)

if (featureRoute) {
  import('./main.jsx')
} else {
  document.body.classList.add('visual-entry-body')
  document.querySelector('#root').innerHTML = `
    <main class="hero-shell" aria-label="机器人视觉入口">
      <div id="hero-stage" class="hero-stage"></div>
      <div id="hero-loading" class="hero-loading">Loading 3D model</div>
      <div id="feature-label" class="feature-label" aria-hidden="true">功能入口</div>
      <div id="transition-overlay" class="transition-overlay" aria-hidden="true"></div>
      <div class="control-stack" aria-label="模型调试控件">
        <section class="particle-panel"><label for="particle-size"><span>星尘尺寸</span><output id="particle-size-value">1.00</output></label><input id="particle-size" type="range" min="0.6" max="1.8" step="0.05" value="1" /></section>
      </div>
      <button id="visual-fallback-entry" class="visual-fallback-entry" type="button">进入智能体工作台</button>
    </main>`
  document.querySelector('#visual-fallback-entry').addEventListener('click', () => window.location.assign('/workbench?source=feature-entry'))
  import('./visual/main.js')
}
