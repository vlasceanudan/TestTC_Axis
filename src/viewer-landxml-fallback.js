/**
 * Reconstructs approximate alignments from visible LandXML-derived viewer
 * geometry when the original XML file cannot be downloaded.
 */

import * as THREE from "three";

const SEMANTIC_PATTERN = /align|axis|baseline|center|centre|chainage|station/i;
const MIN_ALIGNMENT_LENGTH = 15;
const DEDUPE_TOLERANCE = 0.25;

function pointsEqual(a, b, tolerance = DEDUPE_TOLERANCE) {
  return a.distanceToSquared(b) <= tolerance * tolerance;
}

function createPolylineAlignment(points, { id, name, sourceName, initialChainage = 0 }) {
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

  if (totalLength < MIN_ALIGNMENT_LENGTH) return null;

  return {
    id,
    name,
    sourceName,
    initialChainage,
    getLength() {
      return totalLength;
    },
    getPointAtDistance(distance) {
      if (distance <= 0) return cleanedPoints[0].clone();
      if (distance >= totalLength) return cleanedPoints[cleanedPoints.length - 1].clone();

      let traveled = 0;
      for (let i = 0; i < segmentLengths.length; i += 1) {
        const segmentLength = segmentLengths[i];
        if (traveled + segmentLength >= distance) {
          const localDistance = distance - traveled;
          const ratio = segmentLength === 0 ? 0 : localDistance / segmentLength;
          return cleanedPoints[i].clone().lerp(cleanedPoints[i + 1], ratio);
        }
        traveled += segmentLength;
      }

      return cleanedPoints[cleanedPoints.length - 1].clone();
    },
  };
}

function extractSearchText(object) {
  const parts = [
    object.class,
    object.product?.name,
    object.product?.description,
    object.product?.objectType,
  ];

  for (const set of object.properties || []) {
    parts.push(set.name);
    for (const property of set.properties || []) {
      parts.push(property.name);
      parts.push(String(property.value));
    }
  }

  return parts.filter(Boolean).join(" ").toLowerCase();
}

function selectCandidateObjects(objects) {
  const viableObjects = objects.filter((object) => object.position || object.boundingBox);
  const semanticMatches = viableObjects.filter((object) => SEMANTIC_PATTERN.test(extractSearchText(object)));

  if (semanticMatches.length >= 6) {
    return semanticMatches;
  }

  return viableObjects;
}

function isLineLikeBoundingBox(boundingBox) {
  if (!boundingBox?.min || !boundingBox?.max) return false;

  const size = {
    x: Math.abs(boundingBox.max.x - boundingBox.min.x),
    y: Math.abs(boundingBox.max.y - boundingBox.min.y),
    z: Math.abs(boundingBox.max.z - boundingBox.min.z),
  };
  const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
  const [longest, middle, shortest] = dims;

  if (!Number.isFinite(longest) || longest < 2) return false;
  if (middle > Math.max(2.5, longest * 0.3)) return false;
  if (shortest > Math.max(2.5, longest * 0.2)) return false;

  return true;
}

function getBoundingBoxCenterline(boundingBox) {
  if (!isLineLikeBoundingBox(boundingBox)) return [];

  const min = new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z);
  const max = new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const size = max.clone().sub(min);
  const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)];
  const axis = dims.indexOf(Math.max(...dims));
  const axisLength = dims[axis];

  const start = center.clone();
  const end = center.clone();
  start.setComponent(axis, min.getComponent(axis));
  end.setComponent(axis, max.getComponent(axis));

  const sampleCount = Math.max(2, Math.min(10, Math.ceil(axisLength / 4)));
  const points = [];

  for (let i = 0; i <= sampleCount; i += 1) {
    points.push(start.clone().lerp(end, i / sampleCount));
  }

  return points;
}

function getObjectPoints(object) {
  const bboxPoints = getBoundingBoxCenterline(object.boundingBox);
  if (bboxPoints.length >= 2) {
    return bboxPoints;
  }

  if (object.position) {
    return [new THREE.Vector3(object.position.x, object.position.y, object.position.z)];
  }

  return [];
}

function dedupePoints(points) {
  const unique = [];

  for (const point of points) {
    if (!unique.some((existing) => pointsEqual(existing, point))) {
      unique.push(point);
    }
  }

  return unique;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function estimateNeighborThreshold(points) {
  const nearestDistances = [];

  for (let i = 0; i < points.length; i += 1) {
    let nearest = Infinity;

    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const distance = points[i].distanceTo(points[j]);
      if (distance > 0 && distance < nearest) {
        nearest = distance;
      }
    }

    if (Number.isFinite(nearest)) {
      nearestDistances.push(nearest);
    }
  }

  const base = median(nearestDistances);
  if (!Number.isFinite(base) || base <= 0) {
    return 10;
  }

  return Math.max(2, Math.min(20, base * 2.2));
}

function buildPointGraph(points) {
  const threshold = estimateNeighborThreshold(points);
  const graph = Array.from({ length: points.length }, () => []);

  for (let i = 0; i < points.length; i += 1) {
    const distances = [];

    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;

      const distance = points[i].distanceTo(points[j]);
      if (distance <= threshold) {
        distances.push({ index: j, distance });
      }
    }

    distances.sort((a, b) => a.distance - b.distance);

    for (const neighbor of distances.slice(0, 2)) {
      if (!graph[i].some((entry) => entry.index === neighbor.index)) {
        graph[i].push(neighbor);
      }
      if (!graph[neighbor.index].some((entry) => entry.index === i)) {
        graph[neighbor.index].push({ index: i, distance: neighbor.distance });
      }
    }
  }

  return graph;
}

function getComponents(graph) {
  const visited = new Set();
  const components = [];

  for (let i = 0; i < graph.length; i += 1) {
    if (visited.has(i)) continue;

    const queue = [i];
    const component = [];
    visited.add(i);

    while (queue.length) {
      const current = queue.shift();
      component.push(current);

      for (const neighbor of graph[current]) {
        if (!visited.has(neighbor.index)) {
          visited.add(neighbor.index);
          queue.push(neighbor.index);
        }
      }
    }

    components.push(component);
  }

  return components;
}

function getEndpointCandidates(component, graph) {
  const endpoints = component.filter((index) => graph[index].length <= 1);
  return endpoints.length >= 2 ? endpoints : component;
}

function shortestPath(points, graph, start, end) {
  const distances = new Array(points.length).fill(Infinity);
  const previous = new Array(points.length).fill(-1);
  const pending = new Set([start]);
  distances[start] = 0;

  while (pending.size) {
    let current = -1;
    let bestDistance = Infinity;

    for (const candidate of pending) {
      if (distances[candidate] < bestDistance) {
        bestDistance = distances[candidate];
        current = candidate;
      }
    }

    pending.delete(current);
    if (current === end) break;

    for (const neighbor of graph[current]) {
      const nextDistance = distances[current] + neighbor.distance;
      if (nextDistance < distances[neighbor.index]) {
        distances[neighbor.index] = nextDistance;
        previous[neighbor.index] = current;
        pending.add(neighbor.index);
      }
    }
  }

  if (!Number.isFinite(distances[end])) return [];

  const path = [];
  let current = end;
  while (current !== -1) {
    path.push(current);
    current = previous[current];
  }

  return path.reverse();
}

function orderComponentPoints(points, component, graph) {
  if (component.length <= 2) {
    return component.map((index) => points[index]);
  }

  const endpoints = getEndpointCandidates(component, graph);
  let bestPair = null;
  let bestSpan = -Infinity;

  for (let i = 0; i < endpoints.length; i += 1) {
    for (let j = i + 1; j < endpoints.length; j += 1) {
      const span = points[endpoints[i]].distanceToSquared(points[endpoints[j]]);
      if (span > bestSpan) {
        bestSpan = span;
        bestPair = [endpoints[i], endpoints[j]];
      }
    }
  }

  if (!bestPair) {
    return component.map((index) => points[index]);
  }

  const path = shortestPath(points, graph, bestPair[0], bestPair[1]);
  return path.length >= 2 ? path.map((index) => points[index]) : component.map((index) => points[index]);
}

/**
 * Build approximate alignment descriptors from viewer object positions.
 * @param {Array<{ id:number, position?: {x:number,y:number,z:number}, boundingBox?: any, class?:string, product?:any, properties?:any[] }>} objects
 * @param {string} sourceName
 */
export function extractViewerLandXMLAlignments(objects, sourceName) {
  const candidates = selectCandidateObjects(objects);
  const points = dedupePoints(
    candidates.flatMap((object) => getObjectPoints(object))
  );

  if (points.length < 2) {
    return [];
  }

  const graph = buildPointGraph(points);
  const components = getComponents(graph)
    .filter((component) => component.length >= 2)
    .sort((left, right) => right.length - left.length);

  const alignments = [];

  for (let i = 0; i < components.length; i += 1) {
    const orderedPoints = orderComponentPoints(points, components[i], graph);
    const alignment = createPolylineAlignment(orderedPoints, {
      id: `${sourceName}:viewer-fallback:${i + 1}`,
      name: `${sourceName} (viewer geometry ${i + 1})`,
      sourceName,
      initialChainage: 0,
    });

    if (alignment) {
      alignments.push(alignment);
    }
  }

  return alignments;
}
