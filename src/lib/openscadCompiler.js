// OpenSCAD WASM compiler — singleton instance, lazy-loaded on first compile

let instancePromise = null

async function getInstance() {
  if (instancePromise) return instancePromise

  instancePromise = (async () => {
    const { createOpenSCAD } = await import('openscad-wasm')
    const errors = []
    const inst = await createOpenSCAD({
      print: () => {},
      printErr: (line) => errors.push(line),
    })
    inst._errors = errors
    return inst
  })()

  return instancePromise
}

export async function compileOpenSCAD(scadCode) {
  const openscad = await getInstance()
  openscad._errors.length = 0

  let stlString
  try {
    stlString = await openscad.renderToStl(scadCode)
  } catch (err) {
    const detail = openscad._errors.join('\n') || err.message || 'Unknown error'
    throw new Error(detail)
  }

  if (!stlString || stlString.trim().length < 10) {
    const detail = openscad._errors.join('\n') || 'Compilation produced no output — check your SCAD code'
    throw new Error(detail)
  }

  // Encode ASCII STL string to ArrayBuffer (Three.js STLLoader handles both ASCII & binary)
  return new TextEncoder().encode(stlString).buffer
}
