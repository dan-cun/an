import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export function RobotWidget({ task = '正在等待安全任务', onInteract }) {
  const hostRef = useRef(null)
  const interactionsRef = useRef(0)
  const [state, setState] = useState('loading')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let frame = 0
    let renderer
    let disposed = false
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100)
    camera.position.set(0, 0.15, 7.2)
    camera.lookAt(0, 0.25, 0)
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      host.replaceChildren(renderer.domElement)
    } catch {
      setState('fallback')
      return undefined
    }

    scene.add(new THREE.HemisphereLight(0xbfeeff, 0x101820, 1.9))
    const key = new THREE.DirectionalLight(0xffffff, 2.3)
    key.position.set(2, 4, 5)
    scene.add(key)
    const rim = new THREE.PointLight(0x39c8ff, 18, 14)
    rim.position.set(-2, 1, 3)
    scene.add(rim)

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.018, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x3fd9ff, transparent: true, opacity: 0.45 }),
    )
    ring.rotation.x = Math.PI / 2
    ring.position.y = -1.55
    scene.add(ring)

    const resize = () => {
      const width = host.clientWidth || 360
      const height = host.clientHeight || 300
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(host)

    let model
    const draco = new DRACOLoader()
    draco.setDecoderPath('/draco/')
    draco.setDecoderConfig({ type: 'wasm' })
    const loader = new GLTFLoader()
    loader.setDRACOLoader(draco)
    loader.load('/model/machine-draco.glb', (gltf) => {
      if (disposed) return
      model = gltf.scene
      const bounds = new THREE.Box3().setFromObject(model)
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      const scale = 3.25 / Math.max(size.y, 0.001)
      model.scale.setScalar(scale)
      model.position.set(-center.x * scale, -center.y * scale - 1.18, -center.z * scale)
      model.userData.baseY = model.position.y
      model.traverse((node) => {
        if (!node.isMesh) return
        node.frustumCulled = false
        if (node.material) {
          node.material.metalness = Math.min(node.material.metalness ?? 0.4, 0.85)
          node.material.roughness = Math.max(node.material.roughness ?? 0.35, 0.2)
          node.material.needsUpdate = true
        }
      })
      scene.add(model)
      setState('ready')
    }, undefined, () => setState('fallback'))

    const animate = (time) => {
      if (disposed) return
      const seconds = time * 0.001
      if (model) {
        model.rotation.y = Math.sin(seconds * 0.35) * 0.16 + interactionsRef.current * 0.05
        const targetY = model.userData.baseY + Math.sin(seconds * 1.4) * 0.035
        model.position.y += (targetY - model.position.y) * 0.08
      }
      ring.rotation.z = seconds * 0.22
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      draco.dispose()
      renderer.dispose()
      scene.traverse((item) => {
        if (item.geometry) item.geometry.dispose()
        if (item.material) (Array.isArray(item.material) ? item.material : [item.material]).forEach((material) => material.dispose())
      })
    }
  }, [])

  const interact = () => {
    interactionsRef.current += 1
    onInteract?.()
  }

  return <div className={`robot-widget is-${state}`} onClick={interact} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') interact() }}>
    <div className="robot-widget-stage" ref={hostRef} aria-label="安全运营机器人" />
    {state === 'fallback' && <div className="robot-fallback" aria-hidden="true"><span>◉</span><i /><b /><em /></div>}
    <div className="robot-widget-caption"><span className="robot-pulse" /> <b>{task}</b><small>{state === 'ready' ? '点击机器人查看下一步' : state === 'loading' ? '正在加载交互角色' : '交互角色降级显示'}</small></div>
  </div>
}
