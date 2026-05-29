import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export function initThreeScene(container) {
  const width = container.clientWidth
  const height = container.clientHeight

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setClearColor(0x0d0d0d, 1)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  // Scene
  const scene = new THREE.Scene()

  // Grid
  const grid = new THREE.GridHelper(200, 40, 0x222222, 0x1a1a1a)
  scene.add(grid)

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.3)
  scene.add(ambient)

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9)
  dirLight.position.set(80, 120, 80)
  dirLight.castShadow = true
  scene.add(dirLight)

  const fillLight = new THREE.DirectionalLight(0x4466cc, 0.3)
  fillLight.position.set(-60, 40, -60)
  scene.add(fillLight)

  // Camera
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000)
  camera.position.set(80, 60, 100)
  camera.lookAt(0, 0, 0)

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.rotateSpeed = 0.8
  controls.zoomSpeed = 1.2
  controls.panSpeed = 0.8

  // State
  const state = { renderer, scene, camera, controls, container, mesh: null, animId: null }

  // Resize observer
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth
    const h = container.clientHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  })
  ro.observe(container)
  state.ro = ro

  // Animate
  function animate() {
    state.animId = requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }
  animate()

  return state
}

export function loadStlIntoScene(state, stlArrayBuffer) {
  const { scene } = state

  if (state.mesh) {
    scene.remove(state.mesh)
    state.mesh.geometry.dispose()
    state.mesh.material.dispose()
    state.mesh = null
  }

  const loader = new STLLoader()
  const geometry = loader.parse(stlArrayBuffer)
  geometry.computeVertexNormals()
  geometry.center()

  const material = new THREE.MeshStandardMaterial({
    color: 0x8899aa,
    metalness: 0.4,
    roughness: 0.5,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.rotation.x = -Math.PI / 2
  scene.add(mesh)
  state.mesh = mesh

  // Fit camera
  const box = new THREE.Box3().setFromObject(mesh)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = state.camera.fov * (Math.PI / 180)
  const dist = Math.abs(maxDim / Math.sin(fov / 2)) * 0.8
  state.camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7)
  state.controls.target.set(0, 0, 0)
  state.controls.update()
}

export function disposeScene(state) {
  cancelAnimationFrame(state.animId)
  state.ro?.disconnect()
  if (state.mesh) {
    state.mesh.geometry.dispose()
    state.mesh.material.dispose()
  }
  state.renderer.dispose()
  state.container.removeChild(state.renderer.domElement)
}
