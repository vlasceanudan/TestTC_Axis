/**
 * Builds native Trimble Connect markups from generic alignment descriptors.
 */

const MM_PER_METER = 1000;
const RED = { r: 255, g: 40, b: 40, a: 255 };

/**
 * Format metres as a plain station number, e.g. 1250 -> "1250".
 * This matches the reference style shown in the viewer screenshots.
 * @param {number} meters
 * @returns {string}
 */
export function formatChainage(meters) {
  if (!Number.isFinite(meters)) return "--";
  return `${Math.round(meters)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const TEXT_ANCHOR_VERTICAL_HALF_LENGTH = 0.001;

function toMarkupPick(point) {
  return {
    positionX: point.x * MM_PER_METER,
    positionY: point.y * MM_PER_METER,
    positionZ: point.z * MM_PER_METER,
    type: "point",
  };
}

function getProbeDistance(totalLength, intervalMeters) {
  return clamp(Math.min(intervalMeters * 0.15, totalLength * 0.05), 1, 12);
}

function normalize2D(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-6) {
    return { x: 0, y: -1, z: 0 };
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: 0,
  };
}

function getLabelFrame(alignment, distance, totalLength, intervalMeters) {
  const probe = getProbeDistance(totalLength, intervalMeters);
  const before = alignment.getPointAtDistance(Math.max(0, distance - probe));
  const current = alignment.getPointAtDistance(distance);
  const after = alignment.getPointAtDistance(Math.min(totalLength, distance + probe));

  if (!before || !current || !after) {
    return {
      tangent: { x: 0, y: 1, z: 0 },
      normal: { x: -1, y: 0, z: 0 },
      curveBias: 0,
    };
  }

  const tangent = normalize2D({
    x: after.x - before.x,
    y: after.y - before.y,
    z: 0,
  });

  return {
    tangent,
    normal: {
      x: -tangent.y,
      y: tangent.x,
      z: 0,
    },
    curveBias: getCurveBias(before, current, after),
  };
}

function getCurveBias(before, current, after) {
  const inVector = normalize2D({
    x: current.x - before.x,
    y: current.y - before.y,
    z: 0,
  });
  const outVector = normalize2D({
    x: after.x - current.x,
    y: after.y - current.y,
    z: 0,
  });

  const dot = clamp(inVector.x * outVector.x + inVector.y * outVector.y, -1, 1);
  const angle = Math.acos(dot);
  return clamp(angle / (Math.PI * 0.5), 0, 1);
}

/**
 * Build native Trimble text markups at chainage intervals.
 *
 * @param {object} params
 * @param {Array<{
 *   id: string,
 *   name: string,
 *   sourceName?: string,
 *   initialChainage?: number,
 *   getLength: () => number,
 *   getPointAtDistance: (distance: number) => { x:number, y:number, z:number } | null
 * }>} params.alignments
 * @param {number} [params.intervalMeters=100]
 * @param {number} [params.startOffset=0]
 * @returns {{ textMarkups: object[], count: number, alignmentCount: number }}
 */
export function buildChainageMarkups({
  alignments,
  intervalMeters = 100,
  startOffset = 0,
}) {
  if (!Array.isArray(alignments) || alignments.length === 0) {
    throw new Error(
      "No supported alignments were found in the loaded viewer models.\n" +
        "Load an IFC or LandXML model containing alignment geometry, then try again."
    );
  }

  const textMarkups = [];
  let alignmentCount = 0;

  for (const alignment of alignments) {
    const totalLength = alignment.getLength();
    if (!Number.isFinite(totalLength) || totalLength <= 0) continue;

    alignmentCount += 1;
    const initialChainage = alignment.initialChainage ?? 0;
    const labelCount = Math.floor(totalLength / intervalMeters);
    for (let i = 0; i <= labelCount; i += 1) {
      const distance = i * intervalMeters;
      if (distance > totalLength + 0.001) continue;

      const point = alignment.getPointAtDistance(distance);
      if (!point) continue;

      // TC offsets text laterally from the start->end direction of a text
      // markup. A tangent-aligned line therefore pushes labels to one side of
      // curved alignments. Use a tiny vertical segment so the anchor remains on
      // the alignment point without introducing horizontal bias.
      const lineCenter = {
        x: point.x,
        y: point.y,
        z: point.z + 0.2,
      };
      const start = {
        x: lineCenter.x,
        y: lineCenter.y,
        z: lineCenter.z - TEXT_ANCHOR_VERTICAL_HALF_LENGTH,
      };
      const end = {
        x: lineCenter.x,
        y: lineCenter.y,
        z: lineCenter.z + TEXT_ANCHOR_VERTICAL_HALF_LENGTH,
      };

      const label = formatChainage(distance + initialChainage + startOffset);
      textMarkups.push({
        start: toMarkupPick(start),
        end: toMarkupPick(end),
        text: label,
        color: RED,
      });
    }
  }

  return {
    textMarkups,
    count: textMarkups.length,
    alignmentCount,
  };
}

/**
 * Returns the 3D position and tangent direction on an alignment at a given
 * chainage distance. Used to build cutting planes perpendicular to the axis.
 *
 * @param {object} alignment - Alignment descriptor with getLength / getPointAtDistance.
 * @param {number} distance  - Chainage distance along the alignment in metres.
 * @returns {{ position: {x,y,z}, tangent: {x,y,z} } | null}
 */
export function getCuttingPlaneData(alignment, distance) {
  const totalLength = alignment.getLength();
  if (!Number.isFinite(totalLength) || totalLength <= 0) return null;

  const clamped = Math.max(0, Math.min(totalLength, distance));
  const position = alignment.getPointAtDistance(clamped);
  if (!position) return null;

  // Use a short probe (0.5 – 5 m) to compute a true 3D tangent that captures
  // both horizontal curvature and vertical grade — needed for a plane that is
  // genuinely perpendicular to the axis in three dimensions.
  const probe = clamp(totalLength * 0.01, 0.5, 5);
  const before = alignment.getPointAtDistance(Math.max(0, clamped - probe));
  const after = alignment.getPointAtDistance(Math.min(totalLength, clamped + probe));
  if (!before || !after) return null;

  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const dz = after.z - before.z;
  const len = Math.hypot(dx, dy, dz);
  const tangent = len > 1e-6
    ? { x: dx / len, y: dy / len, z: dz / len }
    : { x: 0, y: 1, z: 0 };

  return { position, tangent };
}
