# Swarf.cam

Browser-based CNC CAM tool. Write OpenSCAD, compile to STL, and generate G-code — entirely in the browser with no server required.

## Stack

| Layer | Library |
|-------|---------|
| UI | React 19 + Tailwind CSS 4 |
| Build | Vite 8 |
| Editor | Monaco Editor |
| 3D | Three.js |
| CAD compiler | openscad-wasm |
| Polygon offsets | Clipper.js |

---

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

### Deployment notes

OpenSCAD runs in a SharedArrayBuffer context, which requires these headers on every response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`public/_headers` sets them automatically for Cloudflare Pages and Netlify. For other hosts, configure your server to send both headers or the WASM compiler will not load.

---

## Interface overview

The app is divided into three columns:

```
┌─────────────────┬──────────────────────┬────────────────┐
│  Editor panel   │    3D preview        │  Right panel   │
│  (collapsible)  │    (center)          │  (collapsible) │
│                 │                      │                │
│  ┌───────────┐  │                      │  Setup tab     │
│  │ G-code    │  │                      │  Operations    │
│  │ panel     │  │                      │  tab           │
│  └───────────┘  │                      │                │
└─────────────────┴──────────────────────┴────────────────┘
```

Both side panels can be collapsed using the **▶ / ◀** buttons on their edges. The G-code pane can be resized by dragging the divider between the editor and G-code areas.

---

## Workflow

### 1 — Write your model

The left panel contains a Monaco editor pre-loaded with a sample OpenSCAD jig. Write or paste your own OpenSCAD code. The editor provides syntax highlighting and accepts all standard OpenSCAD constructs.

Click **Compile** to build the STL. A `compiling…` indicator appears in the header while the WASM compiler runs. Once complete, the model appears in the 3D preview and operations are auto-detected.

### 2 — Review detected operations

Swarf.cam analyses the compiled STL geometry and automatically creates machining operations in the **Operations** tab (right panel):

| Operation type | Description |
|---|---|
| **Profile cut** | Outer contour of the model, offset inward by tool radius |
| **Pocket** | Circular, hexagonal, or irregular interior cavities; inside-out concentric passes |
| **Drill** | Holes narrower than the tool diameter — single plunge |
| **Slot** | Through-cuts open on one or both ends (X-direction, Y-direction, or cross/intersecting); concentric rectangular passes |

**Stepped and counterbored features** are handled correctly — each bore level is detected independently using the z-depth at which it first appears, so the inner bore starts cutting from the parent pocket floor rather than from the top of the workpiece.

**Concentric features** (e.g. a hex bolt-head recess with a thread hole through its center) are split into separate operations, each using its own contour at the depth where it was actually visible in the STL.

Each operation card shows:
- Colour swatch (matches the 3D toolpath overlay)
- Label and type
- Detected depth and number of instances
- Z-pass count and last-pass remainder
- Enable / disable checkbox

Click any operation to select it (blue highlight) and see its toolpath highlighted in the 3D view. If a timeline simulation is active, clicking an operation also jumps the timeline scrubber to the start of that operation's toolpath and scrolls the G-code panel to the matching line.

While the timeline is playing or scrubbing, the operations panel shows a green **▶** indicator and left border on the operation currently being executed at the scrubber position — independently of which operation is selected for editing.

### 3 — Configure tool and machine settings

The **Setup** tab (right panel) contains two sections:

**Machine**
| Setting | Default | Notes |
|---|---|---|
| Safety Height | 5 mm | Rapid height above work |
| Origin Safety Height | 10 mm | Height for start/end moves |
| Work Area X / Y | 300 mm | Grid reference in 3D view; also the XY dimensions of the stock in Stock Simulation mode |
| Z Zero | Top of material | Affects how cut depths are calculated in G-code and stock simulation |
| Material Thickness | 10 mm | Height of the stock block in Stock Simulation mode; also used as the Z base offset in Spoilboard mode |

**Global Tool** — applies to all operations unless overridden per-operation:
| Setting | Default |
|---|---|
| Tool Diameter | 3.175 mm (1/8") |
| Feedrate | 1000 mm/min |
| Spindle Speed | 18 000 RPM |
| Stepdown | 1.0 mm |
| Stepover | 85% |
| Direction | Climb |

> Settings are saved to `localStorage` and persist between sessions.

**Per-operation overrides** — select an operation in the Operations tab then click **Override** to set tool parameters for that operation only. Click the field label to clear an override and fall back to the global value.

### 4 — Select a post processor

Use the **Post** dropdown in the header to select the output dialect:

- **GRBL** — standard for most hobby controllers
- **Mach3** — legacy Windows-based controllers
- **LinuxCNC** — open-source CNC controller

### 5 — Generate G-code

G-code is generated automatically whenever the model, operations, or settings change. The output appears in the Monaco editor in the bottom-left panel. Click **↓ Download** to save the `.nc` file.

The generated code includes:
- Header with spindle start and coordinate mode
- A separate section for each enabled operation, labelled with comments
- Inside-out concentric passes for pockets and slots — no retract between rings at the same depth
- Plunge moves at 30% of the cutting feedrate
- A retract to origin safety height at the start and end of each operation

**G-code / timeline sync** — the G-code panel and the timeline simulation are linked. While the timeline plays or scrubs, the G-code panel highlights the current line (blue left border) and scrolls to keep it visible. Clicking any line in the G-code panel jumps the timeline scrubber to the corresponding point in the toolpath and stops playback. Clicks on comment or header lines snap to the nearest motion line before the cursor.

---

## 3D preview controls

| Input | Action |
|---|---|
| Left-drag | Orbit |
| Right-drag / two-finger drag | Pan |
| Scroll | Zoom |

The preview panel has two modes, toggled by the **Stock Sim** button in the panel header.

### Mode 1 — OpenSCAD Render (default)

Shows the compiled STL model with optional overlays:

| Button | Effect |
|---|---|
| **Paths** | Toggle toolpath lines (colour-coded per operation) |
| **Rapids** | Toggle rapid-move lines |
| **Ghost** | Make the model transparent so toolpaths show through |

### Mode 2 — Stock Simulation

Switches to a heightmap-based material-removal simulation. Click **Stock Sim** (amber when active) to enter this mode.

The simulation reads the **Work Area X/Y** and **Material Thickness** from the Setup tab to define the starting stock block, then parses the generated G-code and removes material everywhere the tool travels at cutting depth.

**What you see:**

- A solid tan/wood-coloured block representing the raw stock
- Machined regions shown in grey, with depth visible through lighting and shading
- The full 3D form of the part as it would appear after all enabled operations run

**How it updates:** the simulation re-runs automatically whenever you change the G-code (by clicking Generate), the Work Area dimensions, Material Thickness, or Z Zero mode.

> **Tip:** Set Material Thickness to match your actual stock before generating G-code. When Z Zero is set to "Top of material" the field is now always visible in the Setup tab.

### Timeline simulation

The toolbar below the 3D view lets you simulate the tool motion at real-world feedrates. It is available in both 3D Model and Stock Sim modes once G-code has been generated.

- **▶ / ⏸** — play / pause
- **Speed buttons** — 0.5× · 1× · 2× · 5× · 10×
- **Scrubber** — drag to any point in the program
- **Current move indicator** — shows move type (Feed / Rapid / Plunge) and feedrate at the current position

The tool head in the 3D view moves at the correct speed relative to the configured feedrate. Rapid moves are simulated at 5 000 mm/min; actual machine rapid speed may differ.

**Three-way sync** — the timeline, G-code panel, and operations panel are all linked:

| Action | Effect |
|---|---|
| Play / scrub the timeline | G-code panel scrolls to and highlights the current line; active operation shows a green indicator in the Operations list |
| Click a line in the G-code panel | Timeline jumps to that point and stops playback |
| Click an operation in the Operations panel | Timeline jumps to the start of that operation; G-code panel scrolls to the matching section |

The operations panel maintains two independent states: the **selected** operation (blue border, shows edit controls) and the **timeline-active** operation (green ▶ border, tracks scrubber position). Editing one operation while watching another in the simulation works without interference.

---

## Feature detection details

Swarf.cam slices the STL at multiple Z levels to find features:

- **Top surface slice** — finds features open at the top (pockets, drill holes, slots)
- **Floor-level slices** — for each upward-facing horizontal face found in the mesh, a slice just below that level finds features only accessible from below (inner bores of counterbores, thread holes inside hex-head recesses)

Each detected feature is assigned a `detectionSliceZ` — the Z level where it was first seen. Toolpath generation uses that same slice to find the correct boundary contour, even for features whose STL walls only exist below a parent cavity.

Features are deduplicated across scan levels by position and radius so the same hole is never counted twice.

---

## Known limitations

### Stock simulation

| Limitation | Detail |
|---|---|
| **Grid resolution** | The heightmap is 256 × 256 cells over the full work area. At the default 300 × 300 mm work area that is ~1.2 mm/cell — fine features narrower than ~1–2 mm may have slightly soft edges. |
| **Static side walls** | The four side walls and bottom face are rendered at full material thickness regardless of cuts. Profile cuts that exit through the edge of the stock will not carve the side walls. |
| **Stock covers full work area** | The simulated stock is always Work Area X × Work Area Y, not the workpiece footprint. For a small part on a large machine most of the block will appear untouched. |
| **No arc moves (G2/G3)** | The G-code parser only handles `G0`/`G1` linear moves. Arc moves from post-processors that emit G2/G3 are silently ignored — those tool paths will not appear as material removal. |
| **Plunge-while-traversing Z** | For moves that change X, Y, and Z simultaneously, the simulation uses the deepest Z reached anywhere along the segment. This can slightly overstate material removal on the approach to a cut. In practice, the generated G-code separates plunges from feed moves so this rarely applies. |
| **Tool diameter source** | The simulator reads `; Tool diameter: X mm` from each operation's G-code header comment. If you edit the G-code manually or use a post-processor that omits this comment, the simulation falls back to the global tool diameter and may be inaccurate for operations with per-op overrides. |
| **Stale simulation after settings changes** | If you change Work Area or Material Thickness *without* regenerating G-code, the stock block dimensions update but the simulation still reflects the old G-code. Regenerate G-code to get a fully consistent result. |

### Feature detection

| Limitation | Detail |
|---|---|
| **Freeform pockets** | Only axis-aligned rectangular and roughly circular pockets are classified correctly. Irregular freeform cavities may be grouped with a nearby pocket or missed entirely. |
| **Very shallow features** | Features shallower than ~0.1 mm may not be detected, as the STL slicer operates with 0.05 mm tolerance. |
| **Overlapping operations** | If two detected operations have overlapping toolpaths (e.g. a pocket exactly tangent to a profile), the generated G-code may leave witness marks. No collision detection is performed. |

---

## License

MIT
