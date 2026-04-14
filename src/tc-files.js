/**
 * Trimble Connect Workspace API wrapper.
 */

import { TCPSClient } from "trimble-connect-sdk";

export let tcApi = null;
let accessToken = null;
let placedIconIds = [];
let placedMarkupIds = [];
let placedSectionPlaneIds = [];
let hasPlacedSectionBox = false;
let lastInitTCError = "";
const ICON_BATCH_SIZE = 25;
const MARKUP_BATCH_SIZE = 50;
const tcpsProjectCache = new Map();
const tcpsProjectFileSystemCache = new Map();
const CONNECT_ATTEMPT_TIMEOUT_MS = 4000;

function startsWithTrbSignature(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));
  return bytes.length >= 4 && bytes[0] === 0x1c && bytes[1] === 0x54 && bytes[2] === 0x52 && bytes[3] === 0x42;
}

function getSupportedKind(name = "") {
  if (/\.ifc$/i.test(name)) return "ifc";
  if (/\.(landxml|xml)$/i.test(name)) return "landxml";
  return null;
}

function captureAccessToken(value) {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  if (["granted", "denied", "prompt", "pending", "true", "false"].includes(normalized)) {
    return false;
  }

  accessToken = trimmed;
  return true;
}

function collectCandidateUrls(loadedModel) {
  const candidates = [
    loadedModel?.link,
    loadedModel?.url,
    loadedModel?.file?.link,
    loadedModel?.file?.url,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);

  return [...new Set(candidates)];
}

async function fetchArrayBuffer(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function getCandidateVersionIds(...values) {
  return [...uniq(values), undefined];
}

function normalizeName(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function matchesKindByName(name, kind) {
  if (kind === "ifc") return /\.ifc$/i.test(name || "");
  if (kind === "landxml") return /\.(landxml|xml)$/i.test(name || "");
  return false;
}

function configureTcpsClient() {
  if (!accessToken) {
    throw new Error("Trimble Connect did not provide an access token for file download.");
  }

  TCPSClient.config.credentials = { token: accessToken };
}

async function getTcpsProject(projectId) {
  if (tcpsProjectCache.has(projectId)) {
    return tcpsProjectCache.get(projectId);
  }

  configureTcpsClient();
  const response = await TCPSClient.getProject(projectId);
  tcpsProjectCache.set(projectId, response.data);
  return response.data;
}

async function getTcpsProjectFileSystem(project) {
  if (tcpsProjectFileSystemCache.has(project.id)) {
    return tcpsProjectFileSystemCache.get(project.id);
  }

  configureTcpsClient();
  const response = await TCPSClient.listProjectFileSystemStructure(project);
  const entries = Array.isArray(response?.data) ? response.data : [];
  tcpsProjectFileSystemCache.set(project.id, entries);
  return entries;
}

async function getTcpsFileEntry(project, loadedModel, fileId, versionId) {
  const candidateFileIds = uniq([
    loadedModel?.file?.id,
    fileId,
    loadedModel?.id,
  ]);
  const candidateVersionIds = getCandidateVersionIds(
    versionId,
    loadedModel?.file?.versionId,
    loadedModel?.versionId,
  );

  let lastError = null;

  for (const candidateFileId of candidateFileIds) {
    for (const candidateVersionId of candidateVersionIds) {
      try {
        const response = await TCPSClient.getFile(project, candidateFileId, candidateVersionId);
        return response.data;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Unable to resolve Trimble Connect file metadata.");
}

async function getTcpsProjectSourceFileEntries(project, loadedModel, fileId, versionId, kind) {
  const entries = await getTcpsProjectFileSystem(project);
  const targetNames = uniq([
    loadedModel?.name,
    loadedModel?.file?.name,
  ]).map(normalizeName);
  const targetFileIds = uniq([
    loadedModel?.file?.id,
    fileId,
  ]);
  const targetVersionIds = uniq([
    versionId,
    loadedModel?.file?.versionId,
    loadedModel?.versionId,
  ]);

  const rankedEntries = entries
    .filter((entry) => !entry?.directory)
    .filter((entry) => matchesKindByName(entry?.name, kind))
    .map((entry) => {
      const entryFileId = entry?.fileId || entry?.id;
      const entryName = normalizeName(entry?.name);
      let score = 0;

      if (targetNames.includes(entryName)) score += 100;
      if (targetFileIds.includes(entryFileId)) score += 80;
      if (targetVersionIds.includes(entry?.id)) score += 40;
      if (entryName.endsWith(".landxml")) score += 10;
      if (entryName.endsWith(".xml")) score += 5;

      return { entry, entryFileId, score };
    })
    .filter((candidate) => candidate.entryFileId)
    .sort((left, right) => right.score - left.score);

  const resolvedEntries = [];
  const seenKeys = new Set();
  let lastError = null;

  for (const candidate of rankedEntries) {
    const versionsToTry = getCandidateVersionIds(
      versionId,
      loadedModel?.file?.versionId,
      loadedModel?.versionId
    );

    for (const candidateVersionId of versionsToTry) {
      const key = `${candidate.entryFileId}::${candidateVersionId || "latest"}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      try {
        const response = await TCPSClient.getFile(project, candidate.entryFileId, candidateVersionId);
        const resolvedEntry = response?.data;
        if (!resolvedEntry || !matchesKindByName(resolvedEntry.name, kind)) {
          continue;
        }

        resolvedEntries.push(resolvedEntry);
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (resolvedEntries.length > 0) {
    return resolvedEntries;
  }

  if (targetNames.length > 0) {
    throw lastError || new Error("Unable to resolve the original source file from the Trimble Connect project.");
  }

  return [];
}

async function downloadViaSignedUrl(projectId, loadedModel, fileId, versionId, kind) {
  const project = await getTcpsProject(projectId);
  const candidateEntries = [];

  try {
    const fileEntry = await getTcpsFileEntry(project, loadedModel, fileId, versionId);
    if (fileEntry) {
      candidateEntries.push(fileEntry);
    }
  } catch (error) {
    if (kind !== "landxml") {
      throw error;
    }
  }

  if (kind === "landxml") {
    try {
      const projectEntries = await getTcpsProjectSourceFileEntries(
        project,
        loadedModel,
        fileId,
        versionId,
        kind
      );
      candidateEntries.push(...projectEntries);
    } catch (error) {
      if (candidateEntries.length === 0) {
        throw error;
      }
    }
  }

  let lastError = null;
  const seenEntryKeys = new Set();

  for (const fileEntry of candidateEntries) {
    const entryKey = `${fileEntry?.id || "unknown"}::${fileEntry?.versionId || "latest"}`;
    if (seenEntryKeys.has(entryKey)) continue;
    seenEntryKeys.add(entryKey);

    const candidateVersionIds = getCandidateVersionIds(
      versionId,
      fileEntry?.versionId,
      loadedModel?.file?.versionId,
      loadedModel?.versionId
    );

    for (const candidateVersionId of candidateVersionIds) {
      try {
        const urlResponse = await TCPSClient.getFileDownloadUrl(fileEntry, candidateVersionId);
        const signedUrl = urlResponse?.data?.url;
        if (!signedUrl) continue;

        const buffer = await fetchArrayBuffer(signedUrl, {});
        if (kind === "landxml" && startsWithTrbSignature(buffer)) {
          lastError = new Error("Trimble Connect returned a TRB/TrimBim binary instead of the original LandXML file.");
          continue;
        }

        return buffer;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Unable to download file through the Trimble Connect SDK.");
}

/**
 * Connect to the TC Workspace API.
 * @returns {Promise<boolean>}
 */
export async function initTC() {
  lastInitTCError = "";

  try {
    const { connect } = await import("trimble-connect-workspace-api");

    const onEvent = (eventName, data) => {
      if (eventName === "extension.accessToken") {
        const token =
          data?.accessToken ||
          data?.data ||
          (typeof data === "string" ? data : null);

        if (typeof token === "string" && token.length > 0) {
          accessToken = token;
        }
      }
    };

    const targets = [];
    if (window.parent && window.parent !== window) {
      targets.push({
        target: window.parent,
        label: "parent window",
      });
    }
    targets.push({
      target: window,
      label: "current window",
    });

    let lastError = null;
    for (const candidate of targets) {
      try {
        tcApi = await connectWithTimeout(
          () => connect(candidate.target, onEvent, 5000),
          CONNECT_ATTEMPT_TIMEOUT_MS,
          `Timed out while connecting through the ${candidate.label}.`
        );
        break;
      } catch (error) {
        lastError = error;
        tcApi = null;
      }
    }

    if (!tcApi) {
      throw lastError || new Error("Trimble Connect did not respond to the workspace API handshake.");
    }

    try {
      await tcApi.extension.requestPermission("accesstoken");
    } catch {
      // Ignore permission prompt failures until a download is needed.
    }

    return true;
  } catch (error) {
    tcApi = null;
    lastInitTCError = error?.message || "Trimble Connect workspace API handshake failed.";
    return false;
  }
}

export function getLastInitTCError() {
  return lastInitTCError;
}

/**
 * List supported files currently loaded in the TC viewer.
 * @returns {Promise<Array<{
 *   fileId:string,
 *   modelId:string,
 *   name:string,
 *   versionId:string,
 *   kind:"ifc"|"landxml"
 * }>>}
 */
export async function listLoadedTCFiles() {
  if (!tcApi) return [];

  const models = await tcApi.viewer.getModels("loaded");
  return models
    .map((model) => ({
      fileId: model.file?.id || model.id,
      modelId: model.id,
      name: model.name || model.file?.name,
      versionId: model.versionId || model.file?.versionId,
      kind: getSupportedKind(model.name || model.file?.name),
    }))
    .filter((model) => model.kind);
}

/**
 * Download a loaded viewer model as ArrayBuffer.
 * @param {string} fileId
 * @param {string} modelId
 * @param {string} [versionId]
 * @param {"ifc"|"landxml"} [kind]
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadTCFile(fileId, modelId, versionId, kind) {
  if (!tcApi) throw new Error("Not connected to Trimble Connect.");

  let loadedModel = null;
  try {
    loadedModel = await tcApi.viewer.getLoadedModel(modelId);
  } catch {
    // Continue with other download strategies.
  }

  if (kind !== "landxml" && loadedModel?.blob) {
    return blobToArrayBuffer(loadedModel.blob);
  }

  if (!accessToken) {
    const status = await tcApi.extension.requestPermission("accesstoken");
    captureAccessToken(status);

    if (!accessToken) {
      const permissionValue = await tcApi.extension.getPermission("accesstoken");
      captureAccessToken(permissionValue);

      if (!accessToken && status !== "granted") {
        throw new Error(`Trimble Connect access token permission is not available (${status}).`);
      }
    }

    await waitFor(() => accessToken, 3000);
  }

  if (!accessToken) {
    throw new Error("Trimble Connect did not provide an access token for file download.");
  }

  const project = await tcApi.project.getProject();
  let sdkDownloadError = null;

  try {
    const signedUrlBuffer = await downloadViaSignedUrl(
      project.id,
      loadedModel,
      fileId,
      versionId,
      kind
    );
    return signedUrlBuffer;
  } catch (error) {
    sdkDownloadError = error;
    // Fall through to the legacy viewer/REST download strategies below.
  }

  const base = /^eu/i.test(project?.location ?? "")
    ? "https://eu.app.connect.trimble.com/tc/api/2.0"
    : "https://app.connect.trimble.com/tc/api/2.0";

  const candidateUrls = collectCandidateUrls(loadedModel);
  for (const url of candidateUrls) {
    try {
      const buffer = await fetchArrayBuffer(url, {
        credentials: "include",
      });

      if (kind === "landxml" && startsWithTrbSignature(buffer)) {
        continue;
      }

      return buffer;
    } catch {
      // Try next candidate.
    }
  }

  const fetchOriginalFile = async () => {
    const candidates = [
      `${base}/files/${fileId}/download`,
      `${base}/files/${versionId || modelId}/download`,
      `${base}/projects/${project.id}/files/${fileId}/download`,
    ];

    let lastError = null;
    for (const url of candidates) {
      try {
        return await fetchArrayBuffer(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Unknown Trimble Connect download failure.");
  };

  if (kind === "landxml") {
    let buffer;
    try {
      buffer = await fetchOriginalFile();
    } catch (error) {
      const suffix =
        error?.message === "Failed to fetch"
          ? " The original LandXML download appears to be blocked by the Trimble Connect host/browser context."
          : "";
      const detail = sdkDownloadError?.message ? ` SDK lookup failed: ${sdkDownloadError.message}` : "";
      throw new Error(`Cannot retrieve the original LandXML file.${suffix}${detail}`);
    }

    if (startsWithTrbSignature(buffer)) {
      throw new Error(
        sdkDownloadError?.message ||
          "Trimble Connect returned a TRB/TrimBim binary instead of the original LandXML file."
      );
    }
    return buffer;
  }

  return fetchOriginalFile();
}

/**
 * Place icons in the TC viewer.
 * @param {PointIcon[]} icons
 */
export async function placeTCIcons(icons) {
  if (!tcApi) return;

  await clearTCIcons();

  for (let i = 0; i < icons.length; i += ICON_BATCH_SIZE) {
    const batch = icons.slice(i, i + ICON_BATCH_SIZE);
    await tcApi.viewer.addIcon(batch);
  }

  placedIconIds = icons.map((icon) => icon.id);
}

/**
 * Place native markups in the TC viewer.
 * @param {{ textMarkups?: object[] }} markups
 */
export async function placeTCMarkups(markups) {
  if (!tcApi) return;
  if (
    typeof tcApi.markup?.addTextMarkup !== "function" ||
    typeof tcApi.markup?.removeMarkups !== "function"
  ) {
    throw new Error("This Trimble Connect viewer does not support native text markups.");
  }

  await clearTCMarkups();
  await clearTCIcons();

  const textMarkups = Array.isArray(markups?.textMarkups) ? markups.textMarkups : [];
  const ids = [];

  for (let i = 0; i < textMarkups.length; i += MARKUP_BATCH_SIZE) {
    const batch = textMarkups.slice(i, i + MARKUP_BATCH_SIZE);
    const placed = await tcApi.markup.addTextMarkup(batch);
    ids.push(...placed.map((markup) => markup.id).filter(Number.isFinite));
  }

  placedMarkupIds = ids;
}

/**
 * Remove previously placed icons.
 */
export async function clearTCIcons() {
  if (!tcApi || placedIconIds.length === 0) return;

  try {
    await tcApi.viewer.removeIcon(placedIconIds.map((id) => ({ id })));
  } catch {
    await tcApi.viewer.removeIcon();
  }

  placedIconIds = [];
}

/**
 * Remove previously placed markups.
 */
export async function clearTCMarkups() {
  if (!tcApi || typeof tcApi.markup?.removeMarkups !== "function" || placedMarkupIds.length === 0) {
    return;
  }

  await tcApi.markup.removeMarkups(placedMarkupIds);
  placedMarkupIds = [];
}

/**
 * Place section planes in the TC viewer.
 * @param {Array<{directionX,directionY,directionZ,positionX,positionY,positionZ}>} planes
 */
export async function placeTCSectionPlanes(planes) {
  if (!tcApi || typeof tcApi.viewer?.addSectionPlane !== "function") {
    throw new Error("This Trimble Connect viewer does not support section planes.");
  }

  await clearTCSectionPlanes();
  const placed = await tcApi.viewer.addSectionPlane(planes);
  placedSectionPlaneIds = Array.isArray(placed)
    ? placed.map((p) => p.id).filter(Number.isFinite)
    : [];
}

/**
 * Place a section box in the TC viewer.
 * @param {{positionX:number,positionY:number,positionZ:number,sizeX:number,sizeY:number,sizeZ:number,rotationX:number,rotationY:number,rotationZ:number,rotationW:number}} sectionBox
 */
export async function placeTCSectionBox(sectionBox) {
  if (!tcApi || typeof tcApi.viewer?.addSectionBox !== "function") {
    throw new Error("This Trimble Connect viewer does not support section boxes.");
  }

  await clearTCSectionPlanes();
  await tcApi.viewer.addSectionBox(sectionBox);
  hasPlacedSectionBox = true;

  if (typeof tcApi.viewer?.selectSectionBox === "function") {
    try {
      await tcApi.viewer.selectSectionBox();
    } catch {
      // Optional UI affordance only.
    }
  }
}

/**
 * Remove previously placed section planes.
 */
export async function clearTCSectionPlanes() {
  if (!tcApi) {
    return;
  }

  if (typeof tcApi.viewer?.removeSectionPlanes === "function" && placedSectionPlaneIds.length > 0) {
    await tcApi.viewer.removeSectionPlanes(placedSectionPlaneIds);
    placedSectionPlaneIds = [];
  }

  if (hasPlacedSectionBox && typeof tcApi.viewer?.removeSectionBox === "function") {
    await tcApi.viewer.removeSectionBox();
    hasPlacedSectionBox = false;
  }
}

/**
 * Fit the viewer camera to the clipped contents of a loaded model.
 * @param {string} modelId
 */
export async function zoomToTCModel(modelId) {
  if (!tcApi || typeof tcApi.viewer?.setCamera !== "function" || !modelId) {
    return;
  }

  await tcApi.viewer.setCamera(
    {
      modelObjectIds: [{ modelId, recursive: true }],
    },
    {
      animationTime: 800,
    }
  );
}

/**
 * Move the viewer camera to frame an explicit bounding box.
 * @param {{positionX:number,positionY:number,positionZ:number,sizeX:number,sizeY:number,sizeZ:number}} boundingBoxMm
 */
export async function zoomToTCBoundingBox(boundingBoxMm) {
  if (!tcApi || typeof tcApi.viewer?.setCamera !== "function" || !boundingBoxMm) {
    return;
  }

  const center = {
    x: boundingBoxMm.positionX / 1000,
    y: boundingBoxMm.positionY / 1000,
    z: boundingBoxMm.positionZ / 1000,
  };
  const size = {
    x: Math.max(0.1, boundingBoxMm.sizeX / 1000),
    y: Math.max(0.1, boundingBoxMm.sizeY / 1000),
    z: Math.max(0.1, boundingBoxMm.sizeZ / 1000),
  };

  let currentCamera = null;
  if (typeof tcApi.viewer?.getCamera === "function") {
    try {
      currentCamera = await tcApi.viewer.getCamera();
    } catch {
      // Fall back to a default direction below.
    }
  }

  const fovDegrees =
    Number.isFinite(currentCamera?.fieldOfView) && currentCamera.fieldOfView > 1
      ? currentCamera.fieldOfView
      : 60;
  const fovRadians = (fovDegrees * Math.PI) / 180;
  const radius = Math.hypot(size.x, size.y, size.z) * 0.5;
  const distance = Math.max(8, (radius / Math.tan(fovRadians * 0.5)) * 1.2);

  let viewDirection = { x: 0.65, y: -0.55, z: 0.52 };
  if (
    currentCamera?.position &&
    currentCamera?.lookAt &&
    Number.isFinite(currentCamera.position.x) &&
    Number.isFinite(currentCamera.position.y) &&
    Number.isFinite(currentCamera.position.z) &&
    Number.isFinite(currentCamera.lookAt.x) &&
    Number.isFinite(currentCamera.lookAt.y) &&
    Number.isFinite(currentCamera.lookAt.z)
  ) {
    const dx = currentCamera.position.x - currentCamera.lookAt.x;
    const dy = currentCamera.position.y - currentCamera.lookAt.y;
    const dz = currentCamera.position.z - currentCamera.lookAt.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      viewDirection = { x: dx / len, y: dy / len, z: dz / len };
    }
  }

  await tcApi.viewer.setCamera(
    {
      position: {
        x: center.x + viewDirection.x * distance,
        y: center.y + viewDirection.y * distance,
        z: center.z + viewDirection.z * distance,
      },
      lookAt: center,
      upDirection: currentCamera?.upDirection,
      projectionType: currentCamera?.projectionType,
      fieldOfView: currentCamera?.fieldOfView,
      orthoSize:
        currentCamera?.projectionType === "ortho"
          ? Math.max(size.x, size.y, size.z) * 0.75
          : undefined,
    },
    {
      animationTime: 800,
    }
  );
}

/**
 * Get object metadata and positions for a loaded viewer model.
 * @param {string[]} modelIds
 * @returns {Promise<Array<ObjectProperties>>}
 */
export async function getViewerModelObjects(modelIds) {
  if (!tcApi) return [];

  const ids = [...new Set((Array.isArray(modelIds) ? modelIds : [modelIds]).filter(Boolean))];

  for (const modelId of ids) {
    const collected = await getViewerModelObjectsForId(modelId);
    if (collected.length) {
      return collected;
    }
  }

  return [];
}

async function getViewerModelObjectsForId(modelId) {
  let modelObjects = [];

  try {
    const selector = {
      modelObjectIds: [{ modelId, recursive: true }],
    };
    modelObjects = await tcApi.viewer.getObjects(selector);
  } catch {
    // Fall back to an unfiltered query below.
  }

  if (!modelObjects.length) {
    try {
      modelObjects = await tcApi.viewer.getObjects(undefined, { visible: true });
    } catch {
      try {
        modelObjects = await tcApi.viewer.getObjects();
      } catch {
        return [];
      }
    }
  }

  const target =
    modelObjects.find((entry) => entry.modelId === modelId) ||
    modelObjects[0];
  const objects = target?.objects || [];
  const targetIds = objects.map((object) => object.id);

  const missingIds = objects.filter((object) => !object.position).map((object) => object.id);
  if (missingIds.length) {
    try {
      const positions = await tcApi.viewer.getObjectPositions(target.modelId, missingIds);
      const positionMap = new Map(positions.map((entry) => [entry.id, entry.position]));
      for (const object of objects) {
        if (!object.position && positionMap.has(object.id)) {
          object.position = positionMap.get(object.id);
        }
      }
    } catch {
      // Best effort only.
    }
  }

  if (targetIds.length) {
    try {
      const boxes = await tcApi.viewer.getObjectBoundingBoxes(target.modelId, targetIds);
      const boxMap = new Map(boxes.map((entry) => [entry.id, entry.boundingBox]));

      for (const object of objects) {
        const boundingBox = boxMap.get(object.id);
        if (boundingBox) {
          object.boundingBox = boundingBox;
        }
      }
    } catch {
      // Best effort only.
    }
  }

  return objects.filter((object) => object.position || object.boundingBox);
}

async function blobToArrayBuffer(blob) {
  if (blob instanceof Blob) return blob.arrayBuffer();

  const binary = atob(blob);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function waitFor(condition, ms) {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = () => {
      if (condition() || Date.now() - start >= ms) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };

    check();
  });
}

function connectWithTimeout(runConnect, timeoutMs, timeoutMessage) {
  return Promise.race([
    runConnect(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}
