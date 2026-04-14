/**
 * Loads IFC files and exposes alignment curves in viewer coordinates.
 */

import * as OBC from "@thatopen/components";
import * as THREE from "three";

let state = null;

function getWasmBasePath() {
  return new URL(".", window.location.href).href;
}

async function ensureInit() {
  if (state) return state;

  const components = new OBC.Components();

  // SimpleRenderer expects a container element. Keep it hidden because the
  // add-on only needs parsing, not a visible embedded viewer.
  const host = document.createElement("div");
  host.style.cssText = [
    "position:absolute",
    "width:1px",
    "height:1px",
    "opacity:0",
    "pointer-events:none",
    "overflow:hidden",
  ].join(";");
  document.body.appendChild(host);

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, host, {
    antialias: false,
    alpha: true,
  });
  world.camera = new OBC.SimpleCamera(components);

  components.init();

  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: getWasmBasePath(),
      absolute: true,
    },
  });

  const fragmentsManager = components.get(OBC.FragmentsManager);
  fragmentsManager.onFragmentsLoaded.add((model) => {
    world.scene.three.add(model);
  });

  state = { ifcLoader };
  return state;
}

function getAlignmentName(alignment, index) {
  return alignment?.name || alignment?.data?.Name?.value || `Alignment ${index + 1}`;
}

function createAlignmentDescriptor(alignment, coordinationMatrix, sourceName, index) {
  return {
    id: `${sourceName}:${index}`,
    name: getAlignmentName(alignment, index),
    sourceName,
    initialChainage: alignment.initialKP ?? 0,
    getLength() {
      return alignment.getLength("horizontal");
    },
    getPointAtDistance(distance) {
      const totalLength = alignment.getLength("horizontal");
      if (!Number.isFinite(totalLength) || totalLength <= 0) return null;

      const ratio = Math.min(Math.max(distance / totalLength, 0), 1);
      const point = alignment.getPointAt(ratio, "horizontal");
      if (!point) return null;

      return point.clone().applyMatrix4(coordinationMatrix);
    },
  };
}

/**
 * Extract alignment descriptors from an IFC file buffer.
 * @param {ArrayBuffer} buffer
 * @param {string} sourceName
 */
export async function extractIFCAlignments(buffer, sourceName = "model.ifc") {
  const { ifcLoader } = await ensureInit();
  const model = await ifcLoader.load(new Uint8Array(buffer), true, sourceName);

  if (!model.civilData?.alignments?.size) {
    return [];
  }

  const coordinationMatrix = model.civilData.coordinationMatrix ?? new THREE.Matrix4();
  const alignments = [];

  let index = 0;
  for (const [, alignment] of model.civilData.alignments) {
    const descriptor = createAlignmentDescriptor(
      alignment,
      coordinationMatrix,
      sourceName,
      index
    );

    if (descriptor.getLength() > 0) {
      alignments.push(descriptor);
    }

    index += 1;
  }

  return alignments;
}
