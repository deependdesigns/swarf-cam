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
  dirLight.shadow.mapSize.set(2048, 2048)
  dirLight.shadow.camera.near = 0.1
  dirLight.shadow.camera.far = 1000
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
  const state = { renderer, scene, camera, controls, dirLight, container, mesh: null, animId: null }

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

export function clearToolpaths(state) {
  if (!state.toolpathGroup) return
  state.toolpathGroup.traverse(obj => {
    obj.geometry?.dispose()
    obj.material?.dispose()
  })
  state.scene.remove(state.toolpathGroup)
  state.toolpathGroup = null
  state.opGroups = []
}

export function renderToolpaths(state, toolpathData) {
  clearToolpaths(state)
  if (!toolpathData?.length) return

  let topY = 0
  if (state.mesh) {
    topY = new THREE.Box3().setFromObject(state.mesh).max.y
  }

  const group = new THREE.Group()
  state.opGroups = []

  for (const op of toolpathData) {
    const opGroup = new THREE.Group()
    opGroup.userData.operationId = op.operationId
    // Each op gets its own material so we can change opacity independently
    const mat = new THREE.LineBasicMaterial({ color: op.color, transparent: true, opacity: 1 })
    opGroup.userData.mat = mat

    for (const polyline of op.paths) {
      const ox = state.stlMin?.x ?? 0
      const oy = state.stlMin?.y ?? 0
      const pts = polyline.map(([x, y, z]) => new THREE.Vector3(x - ox, topY + z, -(y - oy)))
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      opGroup.add(new THREE.Line(geo, mat))
    }

    group.add(opGroup)
    state.opGroups.push(opGroup)
  }

  state.scene.add(group)
  state.toolpathGroup = group
}

// Highlight one operation's paths; dim all others. Pass null to reset all to full opacity.
export function highlightOperation(state, operationId) {
  if (!state.opGroups?.length) return
  for (const opGroup of state.opGroups) {
    const mat = opGroup.userData.mat
    if (!mat) continue
    const isSelected = operationId == null || opGroup.userData.operationId === operationId
    mat.opacity = isSelected ? 1.0 : 0.12
  }
}

export function loadStlIntoScene(state, stlArrayBuffer) {
  const { scene } = state

  clearToolpaths(state)

  if (state.mesh) {
    scene.remove(state.mesh)
    state.mesh.geometry.dispose()
    state.mesh.material.dispose()
    state.mesh = null
  }

  const loader = new STLLoader()
  const geometry = loader.parse(stlArrayBuffer)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  const stlMin = geometry.boundingBox.min.clone()
  state.stlMin = stlMin
  // Translate so bottom-left-bottom corner sits at origin (standard CNC: X0 Y0 Z0 at workpiece corner)
  geometry.translate(-stlMin.x, -stlMin.y, -stlMin.z)

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
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = state.camera.fov * (Math.PI / 180)
  const dist = Math.abs(maxDim / Math.sin(fov / 2)) * 0.8
  state.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7)
  state.controls.target.copy(center)
  state.controls.update()

  // Fit shadow frustum to model so the shadow map covers the whole mesh
  const shadowPad = maxDim * 0.6
  const sc = state.dirLight.shadow.camera
  sc.left = -shadowPad
  sc.right = shadowPad
  sc.top = shadowPad
  sc.bottom = -shadowPad
  sc.updateProjectionMatrix()
}

export function updateWorkArea(state, workAreaX, workAreaY) {
  if (state.workAreaLine) {
    state.scene.remove(state.workAreaLine)
    state.workAreaLine.geometry.dispose()
    state.workAreaLine.material.dispose()
    state.workAreaLine = null
  }
  if (!workAreaX || !workAreaY) return

  // CNC X→Three.js X, CNC Y→Three.js -Z; rectangle on the ground plane (Y=0)
  const pts = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(workAreaX, 0, 0),
    new THREE.Vector3(workAreaX, 0, -workAreaY),
    new THREE.Vector3(0, 0, -workAreaY),
    new THREE.Vector3(0, 0, 0),
  ]
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  const mat = new THREE.LineBasicMaterial({ color: 0x225522 })
  state.workAreaLine = new THREE.Line(geo, mat)
  state.scene.add(state.workAreaLine)
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
