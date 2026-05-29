// OpenSCAD WASM compiler — caches the import, creates a fresh instance per compile
// to avoid global C++ state corruption across multiple renderToStl calls.

let importPromise = null

async function getCreateFn() {
  if (!importPromise) {
    importPromise = import('openscad-wasm').then(m => m.createOpenSCAD)
  }
  return importPromise
}

export async function compileOpenSCAD(scadCode) {
  const createOpenSCAD = await getCreateFn()
  const errors = []
  const openscad = await createOpenSCAD({
    print: () => {},
    printErr: (line) => errors.push(line),
  })

  let stlString
  try {
    stlString = await openscad.renderToStl(scadCode)
  } catch (err) {
    const detail = errors.join('\n') || err.message || 'Unknown error'
    throw new Error(detail)
  }

  if (!stlString || stlString.trim().length < 10) {
    const detail = errors.join('\n') || 'Compilation produced no output — check your SCAD code'
    throw new Error(detail)
  }

  return new TextEncoder().encode(stlString).buffer
}
