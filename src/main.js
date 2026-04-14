/**
 * Reads IFC and LandXML alignments from the currently loaded Trimble Connect
 * viewer models and places chainage labels directly in the TC scene.
 */

import * as THREE from "three";
import {
  initTC,
  getLastInitTCError,
  tcApi,
  listLoadedTCFiles,
  downloadTCFile,
  placeTCMarkups,
  clearTCMarkups,
  clearTCIcons,
  placeTCSectionBox,
  clearTCSectionPlanes,
  zoomToTCBoundingBox,
  zoomToTCModel,
  getViewerModelObjects,
} from "./tc-files.js";
import { extractIFCAlignments } from "./ifc-parser.js";
import { extractLandXMLAlignments } from "./landxml-parser.js";
import { buildChainageMarkups, getCuttingPlaneData } from "./alignment-labels.js";

const STORAGE_KEY = "alignment-labeller:v2";

let interval = 100;
let cachedAlignments = [];

const intervalInput = document.getElementById("intervalInput");
const alignmentSelect = document.getElementById("alignmentSelect");
const refreshAlignmentsBtn = document.getElementById("refreshAlignmentsBtn");
const addBtn = document.getElementById("addBtn");
const clearBtn = document.getElementById("clearBtn");
const startPosInput = document.getElementById("startPosInput");
const endPosInput = document.getElementById("endPosInput");
const addPlanesBtn = document.getElementById("addPlanesBtn");
const clearPlanesBtn = document.getElementById("clearPlanesBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");

function getSavedState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState(partialState) {
  const nextState = {
    ...getSavedState(),
    ...partialState,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
}

function getSavedAlignmentRef() {
  const saved = getSavedState();
  return saved.activeAlignment && typeof saved.activeAlignment === "object"
    ? saved.activeAlignment
    : null;
}

function saveActiveAlignment(alignment) {
  if (!alignment) return;

  saveState({
    activeAlignment: {
      id: alignment.id,
      name: alignment.name,
      viewerModelId: alignment.viewerModelId,
      sourceName: alignment.sourceName,
    },
  });

  syncAlignmentSelectValue(alignment);
}

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = type;
}

function startProgress() {
  progressBar.className = "indeterminate";
}

function stopProgress(pct = 0) {
  progressBar.className = "";
  progressBar.style.width = `${pct}%`;
}

function normalizeLookupText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function collectObjectTexts(object) {
  const values = [
    object?.class,
    object?.product?.name,
    object?.product?.description,
    object?.product?.objectType,
  ];

  for (const propertySet of object?.properties || []) {
    values.push(propertySet?.name);
    for (const property of propertySet?.properties || []) {
      values.push(property?.name, property?.value);
    }
  }

  return [...new Set(values.map(normalizeLookupText).filter(Boolean))];
}

function tagAlignmentsWithSource(file, alignments) {
  return alignments.map((alignment) => ({
    ...alignment,
    viewerModelId: file.modelId,
    fileId: file.fileId,
    versionId: file.versionId,
    sourceName: alignment.sourceName || file.name,
  }));
}

function getAlignmentKey(alignment) {
  return `${alignment.viewerModelId || ""}::${alignment.id || ""}`;
}

function getAlignmentGroupKey(alignment) {
  return [
    alignment.viewerModelId || "",
    normalizeLookupText(alignment.name),
    normalizeLookupText(alignment.sourceName),
  ].join("::");
}

function getDropdownAlignmentEntries(alignments) {
  const saved = getSavedAlignmentRef();
  const grouped = new Map();

  for (const alignment of alignments) {
    const key = getAlignmentGroupKey(alignment);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(alignment);
  }

  return [...grouped.entries()].map(([groupKey, groupAlignments]) => {
    const representative =
      groupAlignments.find(
        (alignment) =>
          saved &&
          alignment.id === saved.id &&
          alignment.viewerModelId === saved.viewerModelId
      ) || groupAlignments[0];

    return {
      groupKey,
      alignment: representative,
      label:
        groupAlignments.length > 1
          ? `${representative.name} (${representative.sourceName})`
          : representative.name,
    };
  });
}

function populateAlignmentSelect(alignments) {
  if (!alignmentSelect) return;

  const previousValue = alignmentSelect.value;
  const entries = getDropdownAlignmentEntries(alignments);
  alignmentSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Viewer selection";
  alignmentSelect.appendChild(defaultOption);

  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = getAlignmentKey(entry.alignment);
    option.textContent = entry.label;
    alignmentSelect.appendChild(option);
  }

  alignmentSelect.disabled = entries.length === 0;

  const saved = getSavedAlignmentRef();
  const preferredValue =
    previousValue && [...alignmentSelect.options].some((option) => option.value === previousValue)
      ? previousValue
      : saved
        ? `${saved.viewerModelId || ""}::${saved.id || ""}`
        : "";

  alignmentSelect.value =
    [...alignmentSelect.options].some((option) => option.value === preferredValue)
      ? preferredValue
      : "";
}

function syncAlignmentSelectValue(alignment) {
  if (!alignmentSelect || !alignment) return;

  const value = getAlignmentKey(alignment);
  if ([...alignmentSelect.options].some((option) => option.value === value)) {
    alignmentSelect.value = value;
  }
}

function getAlignmentFromDropdown(alignments) {
  if (!alignmentSelect || !alignmentSelect.value) return [];

  const selected = alignments.find(
    (alignment) => getAlignmentKey(alignment) === alignmentSelect.value
  );

  return selected ? [selected] : [];
}

function getObjectReferencePoint(object) {
  if (object?.position) {
    return object.position;
  }

  const min = object?.boundingBox?.min;
  const max = object?.boundingBox?.max;
  if (!min || !max) {
    return null;
  }

  return {
    x: (min.x + max.x) * 0.5,
    y: (min.y + max.y) * 0.5,
    z: (min.z + max.z) * 0.5,
  };
}

function toThreeVector(point) {
  if (!point) return null;

  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  return new THREE.Vector3(x, y, z);
}

function getBoundingBoxCenter(boundingBox) {
  if (!boundingBox?.min || !boundingBox?.max) return null;

  return new THREE.Vector3(
    (boundingBox.min.x + boundingBox.max.x) * 0.5,
    (boundingBox.min.y + boundingBox.max.y) * 0.5,
    (boundingBox.min.z + boundingBox.max.z) * 0.5
  );
}

function getBoundingBoxCorners(boundingBox) {
  if (!boundingBox?.min || !boundingBox?.max) return [];

  const { min, max } = boundingBox;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function buildSectionBoxFromRange(startData, endData, startPos, endPos, modelObjects = []) {
  const startPoint = toThreeVector(startData?.position);
  const endPoint = toThreeVector(endData?.position);
  if (!startPoint || !endPoint) return null;

  const worldUp = new THREE.Vector3(0, 0, 1);
  const chordHorizontal = endPoint.clone().sub(startPoint).setZ(0);

  let longitudinal =
    chordHorizontal.lengthSq() > 1e-8
      ? chordHorizontal.normalize()
      : new THREE.Vector3(
          (startData.tangent.x + endData.tangent.x) * 0.5,
          (startData.tangent.y + endData.tangent.y) * 0.5,
          0
        );

  if (longitudinal.lengthSq() <= 1e-8) {
    longitudinal = new THREE.Vector3(1, 0, 0);
  } else {
    longitudinal.normalize();
  }

  const lateral = new THREE.Vector3().crossVectors(worldUp, longitudinal).normalize();
  const midpoint = startPoint.clone().add(endPoint).multiplyScalar(0.5);
  const spanMeters = Math.max(0.5, Math.abs(endPos - startPos));
  const localSearchRadius = Math.max(30, spanMeters * 1.5);

  let minLateral = Number.POSITIVE_INFINITY;
  let maxLateral = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const object of modelObjects) {
    const center =
      getBoundingBoxCenter(object.boundingBox) ||
      toThreeVector(object.position);
    if (!center) continue;

    const horizontalDistance = Math.hypot(center.x - midpoint.x, center.y - midpoint.y);
    if (horizontalDistance > localSearchRadius) continue;

    const samples = object.boundingBox
      ? getBoundingBoxCorners(object.boundingBox)
      : [center];

    for (const sample of samples) {
      const relative = sample.clone().sub(midpoint);
      minLateral = Math.min(minLateral, relative.dot(lateral));
      maxLateral = Math.max(maxLateral, relative.dot(lateral));
      minZ = Math.min(minZ, sample.z);
      maxZ = Math.max(maxZ, sample.z);
    }
  }

  if (!Number.isFinite(minLateral) || !Number.isFinite(maxLateral)) {
    minLateral = -15;
    maxLateral = 15;
  }

  if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    minZ = Math.min(startPoint.z, endPoint.z) - 5;
    maxZ = Math.max(startPoint.z, endPoint.z) + 5;
  }

  minLateral -= 2;
  maxLateral += 2;
  minZ -= 2;
  maxZ += 2;

  const center = midpoint
    .clone()
    .add(lateral.clone().multiplyScalar((minLateral + maxLateral) * 0.5));
  center.z = (minZ + maxZ) * 0.5;

  const rotationMatrix = new THREE.Matrix4().makeBasis(
    longitudinal,
    lateral,
    worldUp
  );
  const rotation = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);

  return {
    positionX: center.x * 1000,
    positionY: center.y * 1000,
    positionZ: center.z * 1000,
    sizeX: spanMeters * 1000,
    sizeY: Math.max(8000, (maxLateral - minLateral) * 1000),
    sizeZ: Math.max(8000, (maxZ - minZ) * 1000),
    rotationX: rotation.x,
    rotationY: rotation.y,
    rotationZ: rotation.z,
    rotationW: rotation.w,
  };
}

async function getSelectedViewerObjects() {
  const selection = await tcApi.viewer.getSelection();
  const selectedObjects = [];

  for (const entry of selection || []) {
    const modelId = entry?.modelId;
    const objectIds = Array.isArray(entry?.objectRuntimeIds) ? entry.objectRuntimeIds.filter(Number.isFinite) : [];
    if (!modelId || objectIds.length === 0) continue;

    try {
      const objects = await tcApi.viewer.getObjectProperties(modelId, objectIds);
      for (const object of objects || []) {
        selectedObjects.push({
          modelId,
          object,
          texts: collectObjectTexts(object),
        });
      }
    } catch {
      // Ignore property lookup failures for individual selected models.
    }
  }

  return selectedObjects;
}

function scoreAlignmentMatch(alignment, selectedObject) {
  if (alignment.viewerModelId !== selectedObject.modelId) {
    return 0;
  }

  const alignmentName = normalizeLookupText(alignment.name);
  if (!alignmentName) return 0;

  let score = 0;
  for (const text of selectedObject.texts) {
    if (text === alignmentName) {
      score = Math.max(score, 100);
      continue;
    }

    if (text.includes(alignmentName) || alignmentName.includes(text)) {
      score = Math.max(score, 60);
    }
  }

  return score;
}

function getSelectedAlignmentsFromViewer(alignments, selectedObjects) {
  // Return at most ONE alignment — the single best match across all selected
  // objects. Ties are broken by proximity to the selected object's position.
  let bestScore = 0;
  let bestAlignment = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const selectedObject of selectedObjects) {
    for (const alignment of alignments) {
      const score = scoreAlignmentMatch(alignment, selectedObject);
      if (score <= 0) continue;

      const referencePoint = getObjectReferencePoint(selectedObject.object);
      const distance =
        typeof alignment.getDistanceToPoint === "function" &&
        referencePoint
          ? alignment.getDistanceToPoint(referencePoint)
          : Number.POSITIVE_INFINITY;

      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        bestScore = score;
        bestAlignment = alignment;
        bestDistance = distance;
      }
    }

  }

  if (bestScore < 60 || !bestAlignment) return [];
  return [bestAlignment];
}

function getSavedAlignmentFromState(alignments) {
  const saved = getSavedAlignmentRef();
  if (!saved) return [];

  const byId = alignments.find(
    (alignment) =>
      alignment.id === saved.id &&
      alignment.viewerModelId === saved.viewerModelId
  );
  if (byId) return [byId];

  const normalizedSavedName = normalizeLookupText(saved.name);
  if (!normalizedSavedName) return [];

  const byName = alignments.find(
    (alignment) =>
      alignment.viewerModelId === saved.viewerModelId &&
      normalizeLookupText(alignment.name) === normalizedSavedName
  );

  return byName ? [byName] : [];
}

function resolveActiveAlignment(alignments, selectedObjects) {
  const selectedAlignments = getSelectedAlignmentsFromViewer(alignments, selectedObjects);
  if (selectedAlignments.length > 0) {
    saveActiveAlignment(selectedAlignments[0]);
    return selectedAlignments;
  }

  const dropdownAlignments = getAlignmentFromDropdown(alignments);
  if (dropdownAlignments.length > 0) {
    saveActiveAlignment(dropdownAlignments[0]);
    return dropdownAlignments;
  }

  return getSavedAlignmentFromState(alignments);
}

function setAvailableAlignments(alignments) {
  cachedAlignments = Array.isArray(alignments) ? alignments : [];
  populateAlignmentSelect(cachedAlignments);
}

async function updateViewerSummary() {
  if (!tcApi) {
    setStatus("Open this add-on inside the Trimble Connect 3D viewer to read loaded models.");
    addBtn.disabled = true;
    addPlanesBtn.disabled = true;
    return [];
  }

  const files = await listLoadedTCFiles();
  if (files.length === 0) {
    setStatus(
      "Connected. No loaded IFC or LandXML models are currently visible in the Trimble Connect viewer."
    );
  } else {
    const names = files.map((file) => file.name).join(", ");
    setStatus(
      `Connected. ${files.length} loaded supported model(s) detected in the viewer.\n${names}`
    );
  }

  addBtn.disabled = false;
  addPlanesBtn.disabled = false;
  return files;
}

async function extractAlignmentsFromFile(file, buffer) {
  if (file.kind === "ifc") {
    return extractIFCAlignments(buffer, file.name);
  }

  if (file.kind === "landxml") {
    return extractLandXMLAlignments(buffer, file.name);
  }

  return [];
}

async function loadAvailableAlignments({ announce = true } = {}) {
  const files = await listLoadedTCFiles();
  const warnings = [];
  const alignments = [];

  for (const file of files) {
    if (announce) {
      setStatus(`Reading alignments from ${file.name}...`);
    }

    try {
      const buffer = await downloadTCFile(
        file.fileId,
        file.modelId,
        file.versionId,
        file.kind
      );
      const fileAlignments = await extractAlignmentsFromFile(file, buffer);

      if (fileAlignments.length === 0) {
        warnings.push(`${file.name}: no alignments found`);
        continue;
      }

      alignments.push(...tagAlignmentsWithSource(file, fileAlignments));
    } catch (error) {
      warnings.push(`${file.name}: ${error.message}`);
    }
  }

  setAvailableAlignments(alignments);
  return { files, alignments, warnings };
}

async function refreshAlignmentDropdown({ silent = false } = {}) {
  if (!tcApi) return;

  try {
    const { alignments } = await loadAvailableAlignments({ announce: !silent });
    if (!silent) {
      const count = getDropdownAlignmentEntries(alignments).length;
      setStatus(
        count > 0
          ? `Loaded ${count} visible alignment option${count === 1 ? "" : "s"} from the current viewer models.`
          : "No visible alignments were found in the current viewer models."
      );
    }
  } catch (error) {
    if (!silent) {
      setStatus(`Could not refresh alignment list: ${error.message ?? String(error)}`, "error");
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const saved = getSavedState();
    if (saved.interval) {
      interval = Number(saved.interval);
      intervalInput.value = String(saved.interval);
    }
  } catch {
    // Ignore broken local storage.
  }

  startProgress();
  setStatus("Connecting to Trimble Connect...");

  const connected = await initTC();
  if (connected) {
    try {
      await updateViewerSummary();
      await refreshAlignmentDropdown({ silent: true });
    } catch (error) {
      setStatus(`Could not read loaded viewer models: ${error.message}`, "error");
    }
  } else {
    const detail = getLastInitTCError();
    setStatus(
      detail
        ? `Could not connect to Trimble Connect: ${detail}`
        : "Open this add-on inside the Trimble Connect 3D viewer to read loaded models.",
      "error"
    );
    addBtn.disabled = true;
  }

  stopProgress(100);
  setTimeout(() => stopProgress(0), 600);

  intervalInput.addEventListener("change", () => {
    interval = Math.max(1, parseInt(intervalInput.value, 10) || 100);
    saveState({ interval });
  });
  alignmentSelect?.addEventListener("change", () => {
    const selected = getAlignmentFromDropdown(cachedAlignments);
    if (selected.length > 0) {
      saveActiveAlignment(selected[0]);
    }
  });
  refreshAlignmentsBtn?.addEventListener("click", () => {
    refreshAlignmentDropdown();
  });
  addBtn.addEventListener("click", handleAdd);
  clearBtn.addEventListener("click", handleClear);
  addPlanesBtn.addEventListener("click", handleAddCuttingPlanes);
  clearPlanesBtn.addEventListener("click", handleClearCuttingPlanes);
});

async function handleAdd() {
  interval = Math.max(1, parseInt(intervalInput.value, 10) || 100);
  saveState({ interval });

  if (!tcApi) {
    setStatus("This add-on must run inside the Trimble Connect 3D viewer.", "error");
    return;
  }

  addBtn.disabled = true;
  clearBtn.disabled = true;
  startProgress();

  try {
    const { files, alignments, warnings } = await loadAvailableAlignments({ announce: true });

    if (files.length === 0) {
      throw new Error("No loaded IFC or LandXML models are currently visible in the Trimble Connect viewer.");
    }

    if (alignments.length === 0) {
      throw new Error(warnings.length ? warnings.join("\n") : "No usable alignments were found.");
    }

    const selectedObjects = await getSelectedViewerObjects();
    const selectedAlignments = resolveActiveAlignment(alignments, selectedObjects);
    if (selectedAlignments.length === 0) {
      throw new Error("The current viewer selection did not match any parsed alignment names. Select the alignment object itself in the viewer and try again.");
    }

    setStatus("Computing chainage positions...");
    const { textMarkups, count, alignmentCount } = buildChainageMarkups({
      alignments: selectedAlignments,
      intervalMeters: interval,
    });

    if (count === 0) {
      throw new Error("No label positions were generated from the loaded viewer models.");
    }

    setStatus(`Placing ${count} labels in Trimble Connect...`);
    await placeTCMarkups({ textMarkups });
    clearBtn.disabled = false;

    const warningText = warnings.length ? `\nSkipped:\n${warnings.join("\n")}` : "";
    setStatus(
      `Added ${count} chainage labels for the selected alignment at ${interval} m intervals.${warningText}`,
      warnings.length ? "" : "success"
    );
  } catch (error) {
    setStatus(`Error: ${error.message ?? String(error)}`, "error");
    console.error("[alignment-labeller]", error);
  } finally {
    addBtn.disabled = false;
    stopProgress(0);
  }
}

async function handleClear() {
  clearBtn.disabled = true;

  try {
    await clearTCMarkups();
    await clearTCIcons();
    setStatus("Labels removed from the Trimble Connect viewer.");
  } catch (error) {
    setStatus(`Clear failed: ${error.message}`, "error");
    clearBtn.disabled = false;
  }
}

async function handleAddCuttingPlanes() {
  const startPos = parseFloat(startPosInput.value);
  const endPos = parseFloat(endPosInput.value);

  if (!Number.isFinite(startPos) || !Number.isFinite(endPos)) {
    setStatus("Enter valid start and end positions (in metres) before adding cutting planes.", "error");
    return;
  }

  if (!tcApi) {
    setStatus("This add-on must run inside the Trimble Connect 3D viewer.", "error");
    return;
  }

  addPlanesBtn.disabled = true;
  clearPlanesBtn.disabled = true;
  startProgress();

  try {
    const { alignments, warnings } = await loadAvailableAlignments({ announce: true });

    if (alignments.length === 0) {
      throw new Error(warnings.length ? warnings.join("\n") : "No usable alignments were found.");
    }

    const selectedObjects = await getSelectedViewerObjects();
    const selectedAlignments = resolveActiveAlignment(alignments, selectedObjects);
    if (selectedAlignments.length === 0) {
      throw new Error("The current viewer selection did not match any parsed alignment. Select the alignment object in the viewer and try again.");
    }

    const alignment = selectedAlignments[0];
    const rangeStart = Math.min(startPos, endPos);
    const rangeEnd = Math.max(startPos, endPos);

    const startData = getCuttingPlaneData(alignment, rangeStart);
    const endData = getCuttingPlaneData(alignment, rangeEnd);

    if (!startData) throw new Error(`Could not compute clipping position at chainage ${rangeStart} m.`);
    if (!endData) throw new Error(`Could not compute clipping position at chainage ${rangeEnd} m.`);

    // Two planes bracket the chosen segment:
    //  • Start plane: normal = +tangent → visible side is everything forward of start.
    //  • End plane:   normal = -tangent → visible side is everything behind end.
    // Together they isolate only the segment between the two chainages.
    const modelObjects = await getViewerModelObjects(alignment.viewerModelId);
    const sectionBox = buildSectionBoxFromRange(
      startData,
      endData,
      rangeStart,
      rangeEnd,
      modelObjects
    );

    if (!sectionBox) {
      throw new Error("Could not build a clipping box for the selected chainage range.");
    }

    setStatus("Placing clipping box in Trimble Connect...");
    await placeTCSectionBox(sectionBox);
    await zoomToTCBoundingBox(sectionBox);
    clearPlanesBtn.disabled = false;

    setStatus(
      `Clipped the selected alignment from chainage ${rangeStart} m to ${rangeEnd} m and zoomed to the clipped area.`,
      "success"
    );
  } catch (error) {
    setStatus(`Error: ${error.message ?? String(error)}`, "error");
    console.error("[alignment-labeller]", error);
  } finally {
    addPlanesBtn.disabled = false;
    stopProgress(0);
  }
}

async function handleClearCuttingPlanes() {
  clearPlanesBtn.disabled = true;

  try {
    await clearTCSectionPlanes();
    setStatus("Cutting planes removed from the Trimble Connect viewer.");
  } catch (error) {
    setStatus(`Remove failed: ${error.message}`, "error");
    clearPlanesBtn.disabled = false;
  }
}
