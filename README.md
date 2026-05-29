# Swarf.cam

Browser-based CNC CAM tool. Write OpenSCAD, compile to STL, and generate G-code — entirely in the browser with no server required.

![Swarf.cam UI](src/assets/hero.png)

## Features

- **OpenSCAD editor** — Monaco-powered editor with syntax highlighting; write parametric models and compile to STL in-browser via WebAssembly
- **3D preview** — Three.js renderer with orbit controls and a toolpath visualization overlay
- **Auto-detect operations** — analyses the compiled STL geometry and automatically creates machining operations:
  - Profile cuts (outer contour)
  - Pockets (circular and irregular)
  - Drill holes (including thread holes hidden inside counterbores)
  - Open slots
- **Operations panel** — configure each operation: tool diameter, feedrate, spindle speed, depth, stepdown, climb/conventional direction
- **G-code output** — generates ready-to-run G-code with selectable post processors: GRBL, Mach3, LinuxCNC

## Stack

| Layer | Library |
|-------|---------|
| UI | React 19 + Tailwind CSS 4 |
| Build | Vite 8 |
| Editor | Monaco Editor |
| 3D | Three.js |
| CAD compiler | openscad-wasm |
| Polygon offsets | Clipper.js |

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Build for production

```bash
npm run build
```

The `dist/` folder is a static site — deploy to any static host.

## Deployment notes

OpenSCAD runs in a SharedArrayBuffer context, which requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. The `public/_headers` file sets these automatically for Cloudflare Pages and Netlify deployments.

If you deploy elsewhere, configure your host to serve those two headers on every response, or the WASM compiler will not load.

## Workflow

1. Write or paste OpenSCAD code in the left editor panel
2. Click **Compile** — the model renders in the 3D preview
3. Detected machining operations appear automatically in the right panel
4. Adjust tool parameters (diameter, feedrate, depth, etc.) per operation
5. Select a post processor (GRBL / Mach3 / LinuxCNC) in the header
6. Click **Generate G-code** — output appears in the bottom-left panel, ready to copy

## License

MIT
