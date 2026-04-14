/**
 * Extracts alignment geometry from LandXML files.
 *
 * Best effort:
 * - direct point lists are preferred when present
 * - lines and curves are sampled from plan geometry
 * - spirals fall back to a densified start/end approximation
 */

import * as THREE from "three";

const CURVE_STEP_METERS = 5;
const SPIRAL_STEP_METERS = 5;
const PROFILE_TOLERANCE = 1e-6;
const COORDINATE_ORDER_NORTHING_EASTING = "northing-easting";
const COORDINATE_ORDER_EASTING_NORTHING = "easting-northing";

function stripLeadingBom(text) {
  return text.replace(/^\uFEFF/, "");
}

function detectUtf16Encoding(bytes) {
  const sampleSize = Math.min(bytes.length, 256);
  if (sampleSize < 4) return null;

  let evenZeroes = 0;
  let oddZeroes = 0;
  let evenCount = 0;
  let oddCount = 0;

  for (let i = 0; i < sampleSize; i += 1) {
    if (i % 2 === 0) {
      evenCount += 1;
      if (bytes[i] === 0) evenZeroes += 1;
    } else {
      oddCount += 1;
      if (bytes[i] === 0) oddZeroes += 1;
    }
  }

  const evenRatio = evenCount ? evenZeroes / evenCount : 0;
  const oddRatio = oddCount ? oddZeroes / oddCount : 0;

  if (oddRatio > 0.3 && evenRatio < 0.05) return "utf-16le";
  if (evenRatio > 0.3 && oddRatio < 0.05) return "utf-16be";
  return null;
}

function decodeXmlBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return "";

  let encoding = "utf-8";
  let offset = 0;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  } else {
    encoding = detectUtf16Encoding(bytes) || "utf-8";
  }

  const text = new TextDecoder(encoding, { fatal: false }).decode(bytes.subarray(offset));
  return stripLeadingBom(text).replace(/\u0000/g, "");
}

function extractParserError(doc) {
  const parserError = doc.querySelector("parsererror");
  return parserError?.textContent?.trim() || null;
}

function getChildElements(node) {
  return Array.from(node?.children || []);
}

function getChildrenByLocalName(node, localName) {
  return getChildElements(node).filter((child) => child.localName === localName);
}

function getFirstChildByLocalName(node, localName) {
  return getChildrenByLocalName(node, localName)[0] ?? null;
}

function getDescendantsByLocalName(root, localName) {
  if (!root) return [];
  return Array.from(root.getElementsByTagName("*")).filter((node) => node.localName === localName);
}

function parseStationValue(rawValue, fallback = 0) {
  if (rawValue == null) return fallback;
  const cleaned = String(rawValue).trim().replace(/\+/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : fallback;
}

function parseStationElevation(text) {
  const values = extractNumbers(text);
  if (values.length < 2) return null;

  return {
    station: values[0],
    elevation: values[1],
  };
}

function extractNumbers(text) {
  return String(text || "")
    .match(/[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?/g)
    ?.map(Number)
    .filter((value) => Number.isFinite(value)) ?? [];
}

function parseLandXMLPoint(text, coordinateOrder = COORDINATE_ORDER_NORTHING_EASTING) {
  const values = extractNumbers(text);
  if (values.length < 2) return null;

  const easting =
    coordinateOrder === COORDINATE_ORDER_EASTING_NORTHING
      ? values[0]
      : values[1];
  const northing =
    coordinateOrder === COORDINATE_ORDER_EASTING_NORTHING
      ? values[1]
      : values[0];
  const elevation = values[2] ?? 0;

  return new THREE.Vector3(easting, northing, elevation);
}

function parsePointList(node, dimension, coordinateOrder = COORDINATE_ORDER_NORTHING_EASTING) {
  const values = extractNumbers(node?.textContent || "");
  const points = [];

  for (let i = 0; i + dimension - 1 < values.length; i += dimension) {
    const easting =
      coordinateOrder === COORDINATE_ORDER_EASTING_NORTHING
        ? values[i]
        : values[i + 1];
    const northing =
      coordinateOrder === COORDINATE_ORDER_EASTING_NORTHING
        ? values[i + 1]
        : values[i];

    if (dimension === 2) {
      points.push(new THREE.Vector3(easting, northing, 0));
    } else {
      points.push(new THREE.Vector3(easting, northing, values[i + 2] ?? 0));
    }
  }

  return points;
}

function normalizeAzimuthDegrees(value) {
  let normalized = value % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

function getAzimuthErrorDegrees(expected, actual) {
  const delta = Math.abs(normalizeAzimuthDegrees(expected) - normalizeAzimuthDegrees(actual));
  return Math.min(delta, 360 - delta);
}

function computeAzimuthDegrees(start, end) {
  const deltaE = end.easting - start.easting;
  const deltaN = end.northing - start.northing;
  if (Math.abs(deltaE) < 1e-9 && Math.abs(deltaN) < 1e-9) {
    return NaN;
  }

  return normalizeAzimuthDegrees((Math.atan2(deltaE, deltaN) * 180) / Math.PI);
}

function parseRawCoordinatePair(text) {
  const values = extractNumbers(text);
  if (values.length < 2) return null;

  return { first: values[0], second: values[1] };
}

function asSurveyPoint(pair, coordinateOrder) {
  if (!pair) return null;

  return coordinateOrder === COORDINATE_ORDER_EASTING_NORTHING
    ? { easting: pair.first, northing: pair.second }
    : { easting: pair.second, northing: pair.first };
}

function detectCoordinateOrder(doc) {
  const lineSegments = getDescendantsByLocalName(doc.documentElement, "Line");
  let northingEastingError = 0;
  let eastingNorthingError = 0;
  let samples = 0;

  for (const segment of lineSegments) {
    const expectedAzimuth = parseStationValue(segment.getAttribute("dir"), NaN);
    if (!Number.isFinite(expectedAzimuth)) continue;

    const startPair = parseRawCoordinatePair(getFirstChildByLocalName(segment, "Start")?.textContent);
    const endPair = parseRawCoordinatePair(getFirstChildByLocalName(segment, "End")?.textContent);
    if (!startPair || !endPair) continue;

    const startNE = asSurveyPoint(startPair, COORDINATE_ORDER_NORTHING_EASTING);
    const endNE = asSurveyPoint(endPair, COORDINATE_ORDER_NORTHING_EASTING);
    const startEN = asSurveyPoint(startPair, COORDINATE_ORDER_EASTING_NORTHING);
    const endEN = asSurveyPoint(endPair, COORDINATE_ORDER_EASTING_NORTHING);

    const azimuthNE = computeAzimuthDegrees(startNE, endNE);
    const azimuthEN = computeAzimuthDegrees(startEN, endEN);
    if (!Number.isFinite(azimuthNE) || !Number.isFinite(azimuthEN)) continue;

    northingEastingError += getAzimuthErrorDegrees(expectedAzimuth, azimuthNE);
    eastingNorthingError += getAzimuthErrorDegrees(expectedAzimuth, azimuthEN);
    samples += 1;

    if (samples >= 12) break;
  }

  if (samples === 0) {
    return COORDINATE_ORDER_NORTHING_EASTING;
  }

  return eastingNorthingError + 1e-6 < northingEastingError
    ? COORDINATE_ORDER_EASTING_NORTHING
    : COORDINATE_ORDER_NORTHING_EASTING;
}

function pointsEqual(a, b, tolerance = 1e-6) {
  return a.distanceToSquared(b) <= tolerance * tolerance;
}

function toVector3(value) {
  if (!value) return null;
  if (typeof value.clone === "function" && typeof value.distanceTo === "function") {
    return value;
  }

  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  return new THREE.Vector3(x, y, z);
}

function mergePointArrays(target, incoming) {
  for (const point of incoming) {
    if (!target.length || !pointsEqual(target[target.length - 1], point)) {
      target.push(point);
    }
  }
}

function sampleLine(start, end, segmentCount = 1) {
  const count = Math.max(1, segmentCount);
  const points = [];

  for (let i = 0; i <= count; i += 1) {
    points.push(start.clone().lerp(end, i / count));
  }

  return points;
}

function parseAngleDegrees(rawValue) {
  const value = parseStationValue(rawValue, NaN);
  return Number.isFinite(value) ? (value * Math.PI) / 180 : NaN;
}

function normalizeSweep(sweep, rotation) {
  if (rotation.includes("cw")) {
    while (sweep >= 0) sweep -= Math.PI * 2;
  } else {
    while (sweep <= 0) sweep += Math.PI * 2;
  }
  return sweep;
}

function buildArcFromCenter(
  start,
  end,
  center,
  rotation,
  expectedLength = NaN,
  expectedDelta = NaN
) {
  const radiusStart = center.distanceTo(start);
  const radiusEnd = center.distanceTo(end);
  const radius = (radiusStart + radiusEnd) * 0.5;

  if (!Number.isFinite(radius) || radius <= 0) return null;

  const radiusMismatch = Math.abs(radiusStart - radiusEnd);
  const radiusTolerance = Math.max(0.02, radius * 0.02);
  if (radiusMismatch > radiusTolerance) return null;

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const rawEndAngle = Math.atan2(end.y - center.y, end.x - center.x);
  let ccwSweep = rawEndAngle - startAngle;
  while (ccwSweep <= 0) ccwSweep += Math.PI * 2;
  const cwSweep = ccwSweep - Math.PI * 2;

  let sweep = rotation.includes("cw") ? cwSweep : ccwSweep;
  if (
    (Number.isFinite(expectedLength) && expectedLength > 0) ||
    (Number.isFinite(expectedDelta) && expectedDelta > 0)
  ) {
    sweep = [ccwSweep, cwSweep]
      .map((candidate) => ({
        candidate,
        deltaError:
          Number.isFinite(expectedDelta) && expectedDelta > 0
            ? Math.abs(Math.abs(candidate) - expectedDelta)
            : 0,
        lengthError:
          Number.isFinite(expectedLength) && expectedLength > 0
            ? Math.abs(Math.abs(candidate) * radius - expectedLength)
            : 0,
      }))
      .sort(
        (left, right) =>
          left.deltaError - right.deltaError ||
          left.lengthError - right.lengthError
      )[0].candidate;
  }

  return {
    center,
    radius,
    startAngle,
    sweep,
    arcLength: Math.abs(sweep * radius),
  };
}

function buildArcFromThreePoints(start, mid, end) {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const determinant = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

  if (Math.abs(determinant) < 1e-9) return null;

  const ax2ay2 = ax * ax + ay * ay;
  const bx2by2 = bx * bx + by * by;
  const cx2cy2 = cx * cx + cy * cy;

  const ux =
    (ax2ay2 * (by - cy) + bx2by2 * (cy - ay) + cx2cy2 * (ay - by)) /
    determinant;
  const uy =
    (ax2ay2 * (cx - bx) + bx2by2 * (ax - cx) + cx2cy2 * (bx - ax)) /
    determinant;

  const center = new THREE.Vector3(ux, uy, (start.z + mid.z + end.z) / 3);
  const radius = center.distanceTo(start);
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const midAngle = Math.atan2(mid.y - center.y, mid.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);

  let ccwSweep = endAngle - startAngle;
  while (ccwSweep <= 0) ccwSweep += Math.PI * 2;

  let ccwMid = midAngle - startAngle;
  while (ccwMid < 0) ccwMid += Math.PI * 2;
  while (ccwMid >= Math.PI * 2) ccwMid -= Math.PI * 2;

  const sweep = ccwMid > 0 && ccwMid < ccwSweep ? ccwSweep : ccwSweep - Math.PI * 2;

  return {
    center,
    radius,
    startAngle,
    sweep,
    arcLength: Math.abs(sweep * radius),
  };
}

function sampleArcGeometry(start, end, arcGeometry) {
  const segmentCount = Math.max(8, Math.ceil(arcGeometry.arcLength / CURVE_STEP_METERS));
  const points = [];

  for (let i = 0; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    const angle = arcGeometry.startAngle + arcGeometry.sweep * t;
    const z = start.z + (end.z - start.z) * t;

    points.push(
      new THREE.Vector3(
        arcGeometry.center.x + Math.cos(angle) * arcGeometry.radius,
        arcGeometry.center.y + Math.sin(angle) * arcGeometry.radius,
        z
      )
    );
  }

  return points;
}

function sampleCurve(segment, coordinateOrder) {
  const start = parseLandXMLPoint(getFirstChildByLocalName(segment, "Start")?.textContent, coordinateOrder);
  const end = parseLandXMLPoint(getFirstChildByLocalName(segment, "End")?.textContent, coordinateOrder);
  const center = parseLandXMLPoint(getFirstChildByLocalName(segment, "Center")?.textContent, coordinateOrder);
  const pi = parseLandXMLPoint(getFirstChildByLocalName(segment, "PI")?.textContent, coordinateOrder);

  if (!start || !end) return [];
  const rotation = (segment.getAttribute("rot") || segment.getAttribute("dir") || "ccw").toLowerCase();
  const expectedLength = parseStationValue(segment.getAttribute("length"), NaN);
  const expectedDelta = parseAngleDegrees(segment.getAttribute("delta"));

  let arcGeometry = null;

  if (center) {
    arcGeometry = buildArcFromCenter(
      start,
      end,
      center,
      rotation,
      expectedLength,
      expectedDelta
    );

    if (
      arcGeometry &&
      Number.isFinite(expectedDelta) &&
      expectedDelta > 0 &&
      Math.abs(Math.abs(arcGeometry.sweep) - expectedDelta) > 0.15
    ) {
      arcGeometry = null;
    }
  }

  if (!arcGeometry && pi) {
    arcGeometry = buildArcFromThreePoints(start, pi, end);
  }

  if (!arcGeometry) return [start, end];

  if (
    Number.isFinite(expectedLength) &&
    expectedLength > 0 &&
    Math.abs(arcGeometry.arcLength - expectedLength) > Math.max(2, expectedLength * 0.15)
  ) {
    if (pi) {
      const piArc = buildArcFromThreePoints(start, pi, end);
      if (piArc && Math.abs(piArc.arcLength - expectedLength) < Math.abs(arcGeometry.arcLength - expectedLength)) {
        arcGeometry = piArc;
      }
    } else {
      return [start, end];
    }
  }

  return sampleArcGeometry(start, end, arcGeometry);
}

/**
 * Integrate a clothoid (linearly-varying curvature) numerically using the
 * trapezoidal rule and return the final XY position.
 *
 * θ(s) = theta0 + k1·s + (k2−k1)·s²/(2·L)
 */
function integrateSpiralEnd(x0, y0, k1, k2, length, theta0, steps) {
  let x = x0;
  let y = y0;
  const dt = length / steps;
  for (let i = 0; i < steps; i++) {
    const s0 = i * dt;
    const s1 = s0 + dt;
    const th0 = theta0 + k1 * s0 + (k2 - k1) * s0 * s0 / (2 * length);
    const th1 = theta0 + k1 * s1 + (k2 - k1) * s1 * s1 / (2 * length);
    x += dt * (Math.cos(th0) + Math.cos(th1)) * 0.5;
    y += dt * (Math.sin(th0) + Math.sin(th1)) * 0.5;
  }
  return { x, y };
}

/**
 * Integrate the clothoid and return the full array of sampled THREE.Vector3 points.
 * The last point is snapped to the known exact end to remove accumulated round-off.
 */
function integrateSpiralPoints(start, trueEnd, k1, k2, length, theta0, segmentCount) {
  const points = [];
  let x = start.x;
  let y = start.y;
  const dt = length / segmentCount;

  points.push(new THREE.Vector3(x, y, start.z));

  for (let i = 1; i <= segmentCount; i++) {
    const s0 = (i - 1) * dt;
    const s1 = i * dt;
    const th0 = theta0 + k1 * s0 + (k2 - k1) * s0 * s0 / (2 * length);
    const th1 = theta0 + k1 * s1 + (k2 - k1) * s1 * s1 / (2 * length);
    x += dt * (Math.cos(th0) + Math.cos(th1)) * 0.5;
    y += dt * (Math.sin(th0) + Math.sin(th1)) * 0.5;
    const z = start.z + (trueEnd.z - start.z) * (i / segmentCount);
    points.push(new THREE.Vector3(x, y, z));
  }

  // Snap last point to exact known end to eliminate numerical drift.
  points[points.length - 1].set(trueEnd.x, trueEnd.y, trueEnd.z);
  return points;
}

function sampleSpiral(segment, coordinateOrder, entryBearing = null) {
  const start = parseLandXMLPoint(getFirstChildByLocalName(segment, "Start")?.textContent, coordinateOrder);
  const end   = parseLandXMLPoint(getFirstChildByLocalName(segment, "End")?.textContent, coordinateOrder);

  if (!start || !end) return [];

  const length =
    parseStationValue(segment.getAttribute("length"), NaN) ||
    parseStationValue(segment.getAttribute("Length"), NaN) ||
    start.distanceTo(end);

  if (!Number.isFinite(length) || length <= 0) return [start, end];

  // Parse start and end radii; "INF"/missing means infinite radius (tangent point).
  const parseRadius = (attrName) => {
    const raw = segment.getAttribute(attrName);
    if (!raw || /inf/i.test(raw)) return Infinity;
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : Infinity;
  };

  const radiusStart = parseRadius("radiusStart");
  const radiusEnd   = parseRadius("radiusEnd");
  const rot  = (segment.getAttribute("rot") || segment.getAttribute("dir") || "ccw").toLowerCase();
  const sign = rot.includes("cw") ? -1 : 1;

  const k1 = Number.isFinite(radiusStart) ? sign / radiusStart : 0;
  const k2 = Number.isFinite(radiusEnd)   ? sign / radiusEnd   : 0;

  const chordDir = Math.atan2(end.y - start.y, end.x - start.x);
  const segmentCount = Math.max(8, Math.ceil(length / SPIRAL_STEP_METERS));

  // No curvature data available in XML attributes. Try to recover using the entry
  // bearing from the previous segment so we can integrate the clothoid geometry.
  if (k1 === 0 && k2 === 0) {
    if (entryBearing !== null) {
      // Standard clothoid (tangent-to-arc or arc-to-tangent): k1=0 at tangent end.
      // Chord direction ≈ θ₀ + k₂·L/6 → k₂ ≈ 6·(chordDir − θ₀) / L
      let delta = chordDir - entryBearing;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const k2est = 6 * delta / length;
      if (Math.abs(k2est) > 1e-9) {
        const REFINE_STEPS = 32;
        let theta0 = entryBearing;
        for (let iter = 0; iter < 10; iter++) {
          const comp = integrateSpiralEnd(start.x, start.y, 0, k2est, length, theta0, REFINE_STEPS);
          const err  = Math.hypot(comp.x - end.x, comp.y - end.y);
          if (err < 0.001) break;
          const compDir = Math.atan2(comp.y - start.y, comp.x - start.x);
          let d = chordDir - compDir;
          while (d >  Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          theta0 += d;
        }
        return integrateSpiralPoints(start, end, 0, k2est, length, theta0, segmentCount);
      }
    }
    // True fallback — no curvature data at all.
    return sampleLine(start, end, Math.max(6, Math.ceil(length / SPIRAL_STEP_METERS)));
  }

  // Both radii are available — use the general clothoid formula.
  // Estimate the start bearing θ₀.
  // For a clothoid the chord direction ≈ θ₀ + (k1+k2)·L/4, so invert that.
  const totalAngle = (k1 + k2) * length / 2;
  let theta0 = chordDir - totalAngle / 2;

  // Refine θ₀ by matching the integrated chord direction to the known chord direction.
  // Each iteration adds the angular residual; converges in 3–5 steps for road spirals.
  const REFINE_STEPS = 32;
  for (let iter = 0; iter < 10; iter++) {
    const comp = integrateSpiralEnd(start.x, start.y, k1, k2, length, theta0, REFINE_STEPS);
    const err  = Math.hypot(comp.x - end.x, comp.y - end.y);
    if (err < 0.001) break;                    // sub-millimetre — good enough

    const compDir = Math.atan2(comp.y - start.y, comp.x - start.x);
    let delta = chordDir - compDir;
    // Normalise to (−π, π]
    while (delta >  Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    theta0 += delta;
  }

  return integrateSpiralPoints(start, end, k1, k2, length, theta0, segmentCount);
}

function extractCoordGeomPoints(coordGeom, coordinateOrder) {
  const pointList3D = getFirstChildByLocalName(coordGeom, "PntList3D");
  if (pointList3D) return parsePointList(pointList3D, 3, coordinateOrder);

  const pointList2D = getFirstChildByLocalName(coordGeom, "PntList2D");
  if (pointList2D) return parsePointList(pointList2D, 2, coordinateOrder);

  const points = [];
  for (const child of getChildElements(coordGeom)) {
    let segmentPoints = [];

    if (child.localName === "Line") {
      const start = parseLandXMLPoint(getFirstChildByLocalName(child, "Start")?.textContent, coordinateOrder);
      const end = parseLandXMLPoint(getFirstChildByLocalName(child, "End")?.textContent, coordinateOrder);
      if (start && end) segmentPoints = [start, end];
    } else if (child.localName === "Curve") {
      segmentPoints = sampleCurve(child, coordinateOrder);
    } else if (child.localName === "Spiral") {
      const n = points.length;
      const entryBearing = n >= 2
        ? Math.atan2(points[n - 1].y - points[n - 2].y, points[n - 1].x - points[n - 2].x)
        : null;
      segmentPoints = sampleSpiral(child, coordinateOrder, entryBearing);
    }

    mergePointArrays(points, segmentPoints);
  }

  return points;
}

function extractCoordGeomParts(coordGeom, coordinateOrder) {
  const pointList3D = getFirstChildByLocalName(coordGeom, "PntList3D");
  if (pointList3D) {
    const points = parsePointList(pointList3D, 3, coordinateOrder);
    return points.length >= 2 ? [{ points, chainageOffset: 0 }] : [];
  }

  const pointList2D = getFirstChildByLocalName(coordGeom, "PntList2D");
  if (pointList2D) {
    const points = parsePointList(pointList2D, 2, coordinateOrder);
    return points.length >= 2 ? [{ points, chainageOffset: 0 }] : [];
  }

  const parts = [];
  let currentPoints = [];
  let chainageOffset = 0;

  for (const child of getChildElements(coordGeom)) {
    let segmentPoints = [];

    if (child.localName === "Line") {
      const start = parseLandXMLPoint(getFirstChildByLocalName(child, "Start")?.textContent, coordinateOrder);
      const end = parseLandXMLPoint(getFirstChildByLocalName(child, "End")?.textContent, coordinateOrder);
      if (start && end) segmentPoints = [start, end];
    } else if (child.localName === "Curve") {
      segmentPoints = sampleCurve(child, coordinateOrder);
    } else if (child.localName === "Spiral") {
      const n = currentPoints.length;
      const entryBearing = n >= 2
        ? Math.atan2(currentPoints[n - 1].y - currentPoints[n - 2].y, currentPoints[n - 1].x - currentPoints[n - 2].x)
        : null;
      segmentPoints = sampleSpiral(child, coordinateOrder, entryBearing);
    }

    if (segmentPoints.length < 2) continue;

    if (!currentPoints.length) {
      currentPoints = [...segmentPoints];
      continue;
    }

    const previousEnd = currentPoints[currentPoints.length - 1];
    const nextStart = segmentPoints[0];
    if (pointsEqual(previousEnd, nextStart)) {
      mergePointArrays(currentPoints, segmentPoints);
      continue;
    }

    if (currentPoints.length >= 2) {
      parts.push({ points: currentPoints, chainageOffset });
      chainageOffset += getPolylineLength(currentPoints);
    }

    currentPoints = [...segmentPoints];
  }

  if (currentPoints.length >= 2) {
    parts.push({ points: currentPoints, chainageOffset });
  }

  return parts;
}

function getPolylineLength(points) {
  let totalLength = 0;
  for (let i = 1; i < points.length; i += 1) {
    totalLength += points[i - 1].distanceTo(points[i]);
  }
  return totalLength;
}

function getDistancePointToSegment(point, start, end) {
  const pointVector3 = toVector3(point);
  if (!pointVector3) return Number.POSITIVE_INFINITY;

  const segment = end.clone().sub(start);
  const pointVector = pointVector3.clone().sub(start);
  const segmentLengthSquared = segment.lengthSq();
  if (segmentLengthSquared <= 1e-12) {
    return pointVector3.distanceTo(start);
  }

  const t = Math.max(0, Math.min(1, pointVector.dot(segment) / segmentLengthSquared));
  const projection = start.clone().add(segment.multiplyScalar(t));
  return pointVector3.distanceTo(projection);
}

function getCurveInLength(node) {
  const direct =
    parseStationValue(node.getAttribute("inLength"), NaN) ||
    parseStationValue(node.getAttribute("lengthIn"), NaN) ||
    parseStationValue(node.getAttribute("lenIn"), NaN) ||
    parseStationValue(node.getAttribute("length1"), NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const totalLength = parseStationValue(node.getAttribute("length"), NaN);
  if (Number.isFinite(totalLength) && totalLength > 0) {
    return totalLength / 2;
  }

  return 0;
}

function getCurveOutLength(node) {
  const direct =
    parseStationValue(node.getAttribute("outLength"), NaN) ||
    parseStationValue(node.getAttribute("lengthOut"), NaN) ||
    parseStationValue(node.getAttribute("lenOut"), NaN) ||
    parseStationValue(node.getAttribute("length2"), NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const totalLength = parseStationValue(node.getAttribute("length"), NaN);
  if (Number.isFinite(totalLength) && totalLength > 0) {
    return totalLength / 2;
  }

  return 0;
}

function getOrderedProfileNodes(profileElement) {
  const nodes = [];

  for (const child of getChildElements(profileElement)) {
    const localName = child.localName;
    if (!["PVI", "ParaCurve", "UnsymParaCurve", "CircCurve"].includes(localName)) {
      continue;
    }

    const stationElevation = parseStationElevation(child.textContent);
    if (!stationElevation) continue;

    nodes.push({
      type: localName,
      station: stationElevation.station,
      elevation: stationElevation.elevation,
      node: child,
    });
  }

  return nodes
    .filter((entry) => Number.isFinite(entry.station) && Number.isFinite(entry.elevation))
    .sort((left, right) => left.station - right.station);
}

function createLinearStationProfile(points, profileStaStart = 0) {
  const cleanedPoints = [];

  for (const point of points) {
    if (
      Number.isFinite(point?.station) &&
      Number.isFinite(point?.elevation) &&
      (!cleanedPoints.length || Math.abs(cleanedPoints[cleanedPoints.length - 1].station - point.station) > PROFILE_TOLERANCE)
    ) {
      cleanedPoints.push({ station: point.station, elevation: point.elevation });
    }
  }

  if (cleanedPoints.length < 2) return null;

  const minStation = cleanedPoints[0].station;
  const maxStation = cleanedPoints[cleanedPoints.length - 1].station;

  function evaluate(station) {
    if (station <= minStation) return cleanedPoints[0].elevation;
    if (station >= maxStation) return cleanedPoints[cleanedPoints.length - 1].elevation;

    for (let i = 1; i < cleanedPoints.length; i += 1) {
      const prev = cleanedPoints[i - 1];
      const next = cleanedPoints[i];
      if (station <= next.station + PROFILE_TOLERANCE) {
        const span = next.station - prev.station;
        const ratio = span <= PROFILE_TOLERANCE ? 0 : (station - prev.station) / span;
        return prev.elevation + (next.elevation - prev.elevation) * ratio;
      }
    }

    return cleanedPoints[cleanedPoints.length - 1].elevation;
  }

  return {
    minStation,
    maxStation,
    profileStaStart,
    getElevation(station) {
      return evaluate(station);
    },
  };
}

function createProfAlignProfile(profileElement, profileStaStart = 0) {
  const nodes = getOrderedProfileNodes(profileElement);
  if (nodes.length < 2) return null;

  const curveSegments = [];
  const tangentSegments = [];

  for (let i = 1; i < nodes.length - 1; i += 1) {
    const current = nodes[i];
    if (!["ParaCurve", "UnsymParaCurve", "CircCurve"].includes(current.type)) {
      continue;
    }

    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    const inSpan = current.station - prev.station;
    const outSpan = next.station - current.station;
    if (inSpan <= PROFILE_TOLERANCE || outSpan <= PROFILE_TOLERANCE) {
      continue;
    }

    const inLength = getCurveInLength(current.node);
    const outLength = getCurveOutLength(current.node);
    const startStation = current.station - inLength;
    const endStation = current.station + outLength;
    if (inLength <= PROFILE_TOLERANCE || outLength <= PROFILE_TOLERANCE) {
      continue;
    }
    if (startStation < prev.station - PROFILE_TOLERANCE || endStation > next.station + PROFILE_TOLERANCE) {
      continue;
    }

    const inGrade = (current.elevation - prev.elevation) / inSpan;
    const outGrade = (next.elevation - current.elevation) / outSpan;
    const startElevation = current.elevation - inGrade * inLength;
    const endElevation = current.elevation + outGrade * outLength;
    const length = endStation - startStation;
    if (length <= PROFILE_TOLERANCE) continue;

    curveSegments.push({
      startStation,
      endStation,
      startElevation,
      endElevation,
      inGrade,
      outGrade,
      length,
    });
  }

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const current = nodes[i];
    const next = nodes[i + 1];
    const span = next.station - current.station;
    if (span <= PROFILE_TOLERANCE) continue;

    const currentCurve = curveSegments.find(
      (segment) => Math.abs(segment.endStation - current.station) <= getCurveOutLength(current.node || { getAttribute: () => null }) + PROFILE_TOLERANCE
    );
    const nextCurve = curveSegments.find(
      (segment) => Math.abs(segment.startStation - next.station) <= getCurveInLength(next.node || { getAttribute: () => null }) + PROFILE_TOLERANCE
    );

    const startStation = ["ParaCurve", "UnsymParaCurve", "CircCurve"].includes(current.type)
      ? current.station + getCurveOutLength(current.node)
      : current.station;
    const endStation = ["ParaCurve", "UnsymParaCurve", "CircCurve"].includes(next.type)
      ? next.station - getCurveInLength(next.node)
      : next.station;

    if (endStation - startStation <= PROFILE_TOLERANCE) {
      continue;
    }

    const grade = (next.elevation - current.elevation) / span;
    tangentSegments.push({
      startStation,
      endStation,
      originStation: current.station,
      originElevation: current.elevation,
      grade,
    });
  }

  const minStation = nodes[0].station;
  const maxStation = nodes[nodes.length - 1].station;

  function evaluateCurve(segment, station) {
    const x = station - segment.startStation;
    const t = x / segment.length;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;

    return (
      h00 * segment.startElevation +
      h10 * segment.length * segment.inGrade +
      h01 * segment.endElevation +
      h11 * segment.length * segment.outGrade
    );
  }

  function evaluate(station) {
    for (const segment of curveSegments) {
      if (station >= segment.startStation - PROFILE_TOLERANCE && station <= segment.endStation + PROFILE_TOLERANCE) {
        const clamped = Math.min(segment.endStation, Math.max(segment.startStation, station));
        return evaluateCurve(segment, clamped);
      }
    }

    for (const segment of tangentSegments) {
      if (station >= segment.startStation - PROFILE_TOLERANCE && station <= segment.endStation + PROFILE_TOLERANCE) {
        return segment.originElevation + segment.grade * (station - segment.originStation);
      }
    }

    if (station <= minStation) {
      const first = tangentSegments[0];
      return first
        ? first.originElevation + first.grade * (station - first.originStation)
        : nodes[0].elevation;
    }

    const lastTangent = tangentSegments[tangentSegments.length - 1];
    return lastTangent
      ? lastTangent.originElevation + lastTangent.grade * (station - lastTangent.originStation)
      : nodes[nodes.length - 1].elevation;
  }

  return {
    minStation,
    maxStation,
    profileStaStart,
    getElevation(station) {
      return evaluate(station);
    },
  };
}

function selectProfileElement(elements, alignmentName) {
  if (!elements.length) return null;

  const normalizedAlignmentName = String(alignmentName || "").trim().toLowerCase();
  if (!normalizedAlignmentName) return elements[0];

  return (
    elements.find((element) => String(element.getAttribute("name") || "").trim().toLowerCase() === normalizedAlignmentName) ||
    elements[0]
  );
}

function extractVerticalProfile(alignmentElement) {
  const profiles = getChildrenByLocalName(alignmentElement, "Profile");
  if (!profiles.length) return null;

  const alignmentName = alignmentElement.getAttribute("name") || alignmentElement.getAttribute("desc") || "";

  for (const profile of profiles) {
    const profileStaStart =
      parseStationValue(profile.getAttribute("staStart"), 0) ||
      parseStationValue(profile.getAttribute("startSta"), 0);

    const profAlign = selectProfileElement(getChildrenByLocalName(profile, "ProfAlign"), alignmentName);
    if (profAlign) {
      const parsed = createProfAlignProfile(profAlign, profileStaStart);
      if (parsed) return parsed;
    }

    const profSurf = selectProfileElement(getChildrenByLocalName(profile, "ProfSurf"), alignmentName);
    if (profSurf) {
      const pntList2D = getFirstChildByLocalName(profSurf, "PntList2D");
      if (pntList2D) {
        const values = extractNumbers(pntList2D.textContent || "");
        const points = [];
        for (let i = 0; i + 1 < values.length; i += 2) {
          points.push({ station: values[i], elevation: values[i + 1] });
        }

        const parsed = createLinearStationProfile(points, profileStaStart);
        if (parsed) return parsed;
      }
    }
  }

  return null;
}

function resolveProfileStation(profile, localDistance, initialChainage = 0) {
  if (!profile) return localDistance;

  const candidates = [
    localDistance + initialChainage,
    localDistance,
    localDistance + (profile.profileStaStart || 0),
    localDistance + initialChainage + (profile.profileStaStart || 0),
  ].filter(Number.isFinite);

  const min = profile.minStation;
  const max = profile.maxStation;
  for (const candidate of candidates) {
    if (candidate >= min - PROFILE_TOLERANCE && candidate <= max + PROFILE_TOLERANCE) {
      return candidate;
    }
  }

  return candidates.reduce((best, candidate) => {
    const bestDistance =
      best < min ? min - best : best > max ? best - max : 0;
    const candidateDistance =
      candidate < min ? min - candidate : candidate > max ? candidate - max : 0;
    return candidateDistance < bestDistance ? candidate : best;
  }, candidates[0] ?? localDistance);
}

function createPolylineAlignment(points, { id, name, sourceName, initialChainage = 0, verticalProfile = null }) {
  const cleanedPoints = [];

  for (const point of points) {
    if (!cleanedPoints.length || !pointsEqual(cleanedPoints[cleanedPoints.length - 1], point)) {
      cleanedPoints.push(point.clone());
    }
  }

  if (cleanedPoints.length < 2) return null;

  const segmentLengths = [];
  let totalLength = 0;

  for (let i = 1; i < cleanedPoints.length; i += 1) {
    const length = cleanedPoints[i - 1].distanceTo(cleanedPoints[i]);
    segmentLengths.push(length);
    totalLength += length;
  }

  if (totalLength <= 0) return null;

  return {
    id,
    name,
    sourceName,
    initialChainage,
    getLength() {
      return totalLength;
    },
    getDistanceToPoint(point) {
      if (!point || cleanedPoints.length < 2) return Number.POSITIVE_INFINITY;

      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 1; i < cleanedPoints.length; i += 1) {
        bestDistance = Math.min(
          bestDistance,
          getDistancePointToSegment(point, cleanedPoints[i - 1], cleanedPoints[i])
        );
      }

      return bestDistance;
    },
    getPointAtDistance(distance) {
      if (distance <= 0) {
        const startPoint = cleanedPoints[0].clone();
        if (verticalProfile) {
          const station = resolveProfileStation(verticalProfile, 0, initialChainage);
          startPoint.z = verticalProfile.getElevation(station);
        }
        return startPoint;
      }
      if (distance >= totalLength) {
        const endPoint = cleanedPoints[cleanedPoints.length - 1].clone();
        if (verticalProfile) {
          const station = resolveProfileStation(verticalProfile, totalLength, initialChainage);
          endPoint.z = verticalProfile.getElevation(station);
        }
        return endPoint;
      }

      let traveled = 0;
      for (let i = 0; i < segmentLengths.length; i += 1) {
        const segmentLength = segmentLengths[i];
        if (traveled + segmentLength >= distance) {
          const localDistance = distance - traveled;
          const ratio = segmentLength === 0 ? 0 : localDistance / segmentLength;
          const point = cleanedPoints[i].clone().lerp(cleanedPoints[i + 1], ratio);
          if (verticalProfile) {
            const station = resolveProfileStation(verticalProfile, distance, initialChainage);
            point.z = verticalProfile.getElevation(station);
          }
          return point;
        }
        traveled += segmentLength;
      }

      const fallback = cleanedPoints[cleanedPoints.length - 1].clone();
      if (verticalProfile) {
        const station = resolveProfileStation(verticalProfile, totalLength, initialChainage);
        fallback.z = verticalProfile.getElevation(station);
      }
      return fallback;
    },
  };
}

function getAlignmentName(alignmentElement, index) {
  return (
    alignmentElement.getAttribute("name") ||
    alignmentElement.getAttribute("desc") ||
    `Alignment ${index + 1}`
  );
}

function extractLandXMLAlignmentsForOrder(doc, sourceName, coordinateOrder, orderSuffix = "") {
  const alignmentElements = getDescendantsByLocalName(doc.documentElement, "Alignment");
  const alignments = [];

  alignmentElements.forEach((alignmentElement, index) => {
    const coordGeom = getFirstChildByLocalName(alignmentElement, "CoordGeom");
    if (!coordGeom) return;

    const parts = extractCoordGeomParts(coordGeom, coordinateOrder);
    const verticalProfile = extractVerticalProfile(alignmentElement);
    const baseInitialChainage =
      parseStationValue(alignmentElement.getAttribute("staStart"), 0) ||
      parseStationValue(alignmentElement.getAttribute("startSta"), 0);
    const alignmentName = getAlignmentName(alignmentElement, index);

    parts.forEach((part, partIndex) => {
      const descriptor = createPolylineAlignment(part.points, {
        id: `${sourceName}:${index}:${partIndex}${orderSuffix}`,
        name: alignmentName,
        sourceName,
        initialChainage: baseInitialChainage + part.chainageOffset,
        verticalProfile,
      });

      if (descriptor) {
        alignments.push({
          ...descriptor,
          coordinateOrder,
        });
      }
    });

    if (parts.length === 0) {
      const fallbackPoints = extractCoordGeomPoints(coordGeom, coordinateOrder);
      const descriptor = createPolylineAlignment(fallbackPoints, {
        id: `${sourceName}:${index}:0${orderSuffix}`,
        name: alignmentName,
        sourceName,
        initialChainage: baseInitialChainage,
        verticalProfile,
      });

      if (descriptor) {
        alignments.push({
          ...descriptor,
          coordinateOrder,
        });
      }
    }
  });

  return alignments;
}

/**
 * Extract alignment descriptors from a LandXML file buffer.
 * @param {ArrayBuffer} buffer
 * @param {string} sourceName
 */
export function extractLandXMLAlignments(buffer, sourceName = "model.landxml") {
  const text = decodeXmlBuffer(buffer);
  const doc = new DOMParser().parseFromString(text, "application/xml");

  const parserError = extractParserError(doc);
  if (parserError) {
    const snippet = text.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new Error(
      snippet
        ? `Invalid XML document. Starts with: ${snippet}`
        : `Invalid XML document. ${parserError}`
    );
  }

  if (doc.documentElement?.localName !== "LandXML") {
    throw new Error("XML file is not a LandXML document.");
  }

  const detectedOrder = detectCoordinateOrder(doc);
  const alternateOrder =
    detectedOrder === COORDINATE_ORDER_EASTING_NORTHING
      ? COORDINATE_ORDER_NORTHING_EASTING
      : COORDINATE_ORDER_EASTING_NORTHING;

  const primaryAlignments = extractLandXMLAlignmentsForOrder(
    doc,
    sourceName,
    detectedOrder,
    detectedOrder === COORDINATE_ORDER_EASTING_NORTHING ? ":en" : ":ne"
  );

  const alternateAlignments = extractLandXMLAlignmentsForOrder(
    doc,
    sourceName,
    alternateOrder,
    alternateOrder === COORDINATE_ORDER_EASTING_NORTHING ? ":en" : ":ne"
  );

  return [...primaryAlignments, ...alternateAlignments];
}
