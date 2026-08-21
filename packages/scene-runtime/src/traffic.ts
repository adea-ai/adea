import * as THREE from "three";
import RAPIER, { type World as RapierWorld } from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const TRAFFIC_CULL_DISTANCE = 250;
const TRAFFIC_CULL_DISTANCE_SQ = TRAFFIC_CULL_DISTANCE * TRAFFIC_CULL_DISTANCE;

export interface TrafficConfig {
  trackUrl: string;
  modelUrls: string[];
  /** Desired world-space footprint length for each model URL. */
  modelTargetLengths?: Record<string, number>;
  /** Local model axis that points toward the vehicle front. */
  modelForwardAxes?: Record<string, TrafficModelForwardAxis>;
  /** Local model yaw correction applied before the route-facing transform. */
  modelYawOffsets?: Record<string, number>;
  /** Explicit roundabout zones for authored loops the graph cannot classify. */
  roundaboutZones?: readonly TrafficRoundaboutZone[];
  count?: number;
  lowTierCount?: number;
  speedRange?: [number, number];
  /** Lane side to use when the track contains explicit lane metadata. */
  laneSide?: "left" | "right";
  /** Player collision range is intentionally independent of visual culling. */
  collisionRadius?: number;
  lowTierCollisionRadius?: number;
  maxActiveColliders?: number;
  lowTierMaxActiveColliders?: number;
  /** Deterministic override for tests and performance profiles. */
  deviceTier?: "high" | "standard" | "low";
  /** Emit junction decisions when the scene is being diagnosed. */
  debugDecisions?: boolean;
}

export type TrafficModelForwardAxis = "+X" | "-X" | "+Z" | "-Z";
export type TrafficRoundaboutZone = { x: number; z: number; radius: number };
export type TrafficRoundaboutPhase = "inside" | "cooldown";
export interface TrafficRoundaboutState {
  junctionId: number;
  junctionKind?: Exclude<TrafficJunctionKind, null>;
  phase: TrafficRoundaboutPhase;
  seenEdgeIds: Set<number>;
  cooldownDistance: number;
}

export function resolveTrafficModelYawOffset(axis: TrafficModelForwardAxis): number {
  if (axis === "-X") return Math.PI;
  if (axis === "+Z") return Math.PI / 2;
  if (axis === "-Z") return -Math.PI / 2;
  return 0;
}

export type TrafficDecisionReason = "normal" | "roundabout" | "dead-end" | "no-legal-turn";

export interface TrafficDecisionEvent {
  edgeId: number;
  nextEdgeId: number | null;
  junctionId: number | null;
  turnDot: number | null;
  reason: TrafficDecisionReason;
  rejectedUTurns: Array<{ edgeId: number; turnDot: number }>;
}

type LegacyTrackPoint = readonly [number, number, number];
type SurfaceTrackPoint = readonly [number, number, number, number, number, number];
export type TrackPoint = LegacyTrackPoint | SurfaceTrackPoint;
type TrackLaneSide = "left" | "right";
type TrafficJunctionKind = "intersection" | "roundabout" | null;

interface TrackLaneDefinition {
  id: string;
  side: TrackLaneSide;
  direction?: "forward" | "reverse";
  closed?: boolean;
  laneOffset?: number;
  points?: TrackPoint[];
}

interface TrafficTrackDefinition {
  version: number;
  trafficSide?: TrackLaneSide;
  junctionMergeDistance?: number;
  centerline?: TrackPoint[];
  lanes?: TrackLaneDefinition[];
}

export interface ClosedTrafficRoute {
  positions: THREE.Vector3[];
  normals: THREE.Vector3[];
  /** cumulativeLengths[i] is the start of segment i; the last value is totalLength. */
  cumulativeLengths: number[];
  segmentLengths: number[];
  totalLength: number;
  maxWaypointGap: number;
}

interface TrafficCar {
  group: THREE.Group;
  debugIndex: number;
  modelUrl: string;
  edge: TrafficGraphEdge;
  edgeDistance: number;
  recentEdgeIds: number[];
  recentSpatialKeys: string[];
  recentJunctionIds: number[];
  roundaboutState: TrafficRoundaboutState | null;
  speed: number;
  groundOffset: number;
  halfExtents: THREE.Vector3;
  body: RAPIER.RigidBody | null;
  stalled: boolean;
}

export interface TrafficGraphNode {
  id: number;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  outgoing: TrafficGraphEdge[];
  /** Other authored exits beginning at the same physical junction. */
  junctionExits: TrafficGraphEdge[];
  junctionHasCrossExit: boolean;
  junctionId: number | null;
  junctionKind: TrafficJunctionKind;
}

export interface TrafficGraphEdge {
  id: number;
  from: TrafficGraphNode;
  to: TrafficGraphNode;
  length: number;
  tangent: THREE.Vector3;
}

export interface TrafficFollowerSample {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  halfLength: number;
}

export interface AuthoredTrafficGraph {
  nodes: TrafficGraphNode[];
  edges: TrafficGraphEdge[];
  cumulativeLengths: number[];
  totalLength: number;
  maxEdgeLength: number;
}

export function applyTrafficRoundaboutZones(
  graph: AuthoredTrafficGraph,
  zones: readonly TrafficRoundaboutZone[],
): void {
  for (let index = 0; index < zones.length; index++) {
    const zone = zones[index];
    const junctionId = -(index + 1);
    for (const node of graph.nodes) {
      if (Math.hypot(node.position.x - zone.x, node.position.z - zone.z) > zone.radius) continue;
      node.junctionId = junctionId;
      node.junctionKind = "roundabout";
    }
    for (const node of graph.nodes) {
      if (node.junctionId !== junctionId) continue;
      const exits = graph.edges.filter(
        (edge) =>
          edge.from.junctionId === junctionId &&
          edge.to.junctionId !== junctionId &&
          edge.from.position.distanceTo(node.position) <= TRAFFIC_JUNCTION_EXIT_RADIUS,
      );
      node.junctionExits = exits;
      node.junctionHasCrossExit = exits.length > 0;
    }
  }
}

export interface Traffic {
  group: THREE.Group;
  update: (dt: number, playerPosition?: THREE.Vector3) => void;
  dispose: () => void;
  stats: {
    nodes: number;
    edges: number;
    totalLength: number;
    cars: number;
    maxWaypointGap: number;
  };
  attachPhysics: (world: RapierWorld) => void;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function pointPosition(point: TrackPoint): THREE.Vector3 {
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function pointNormal(point: TrackPoint): THREE.Vector3 {
  if (point.length >= 6) {
    const normal = new THREE.Vector3(point[3], point[4], point[5]);
    if (normal.lengthSq() > 1e-8) {
      normal.normalize();
      if (normal.y < 0) normal.negate();
      return normal;
    }
  }
  return WORLD_UP.clone();
}

/**
 * Build one cumulative-length entry for every authored segment. Closed routes
 * always include the explicit final waypoint -> first waypoint segment.
 */
export function buildClosedRoute(
  points: readonly TrackPoint[],
  reverse = false,
): ClosedTrafficRoute {
  const ordered = reverse ? [...points].reverse() : [...points];
  const positions: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  for (const point of ordered) {
    const position = pointPosition(point);
    const previous = positions.at(-1);
    if (previous && previous.distanceTo(position) < 0.01) continue;
    positions.push(position);
    normals.push(pointNormal(point));
  }
  if (positions.length > 2 && positions[0].distanceTo(positions.at(-1)!) < 0.01) {
    positions.pop();
    normals.pop();
  }
  if (positions.length < 3)
    throw new Error("A closed traffic route requires at least three distinct waypoints");

  const cumulativeLengths = [0];
  const segmentLengths: number[] = [];
  let totalLength = 0;
  let maxWaypointGap = 0;
  for (let i = 0; i < positions.length; i++) {
    const length = positions[i].distanceTo(positions[(i + 1) % positions.length]);
    if (!Number.isFinite(length) || length < 0.01)
      throw new Error(`Traffic route segment ${i} is invalid`);
    segmentLengths.push(length);
    totalLength += length;
    maxWaypointGap = Math.max(maxWaypointGap, length);
    cumulativeLengths.push(totalLength);
  }
  return { positions, normals, cumulativeLengths, segmentLengths, totalLength, maxWaypointGap };
}

function findSegment(route: ClosedTrafficRoute, wrappedDistance: number): number {
  let low = 0;
  let high = route.segmentLengths.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (wrappedDistance < route.cumulativeLengths[middle]) high = middle - 1;
    else if (wrappedDistance >= route.cumulativeLengths[middle + 1]) low = middle + 1;
    else return middle;
  }
  return route.segmentLengths.length - 1;
}

/** Sample a closed route in logarithmic time, including across its wrap boundary. */
export function sampleClosedRoute(
  route: ClosedTrafficRoute,
  distance: number,
  position: THREE.Vector3,
  tangent: THREE.Vector3,
  normal: THREE.Vector3,
): number {
  const wrapped = ((distance % route.totalLength) + route.totalLength) % route.totalLength;
  const segment = findSegment(route, wrapped);
  const next = (segment + 1) % route.positions.length;
  const t = (wrapped - route.cumulativeLengths[segment]) / route.segmentLengths[segment];
  position.lerpVectors(route.positions[segment], route.positions[next], t);
  tangent.copy(route.positions[next]).sub(route.positions[segment]).normalize();
  normal.lerpVectors(route.normals[segment], route.normals[next], t).normalize();
  if (normal.y < 0) normal.negate();
  return segment;
}

/**
 * Convert an authored route walk into a directed road graph. Only non-local
 * occurrences of the same authored lane position are joined, so dense
 * neighbouring samples remain intact while repeated roundabout/junction
 * passes become explicit choices. The closing segment is included.
 */
export function buildAuthoredTrafficGraph(
  route: ClosedTrafficRoute,
  junctionMergeDistance = 0.08,
): AuthoredTrafficGraph {
  const count = route.positions.length;
  type JunctionCluster = { id: number; representative: number; occurrences: number[] };
  const clusters: JunctionCluster[] = [];
  const occurrenceClusters: JunctionCluster[] = [];
  const buckets = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x / junctionMergeDistance)},${Math.round(y / junctionMergeDistance)},${Math.round(z / junctionMergeDistance)}`;
  for (let index = 0; index < count; index++) {
    const point = route.positions[index];
    const bx = Math.round(point.x / junctionMergeDistance);
    const by = Math.round(point.y / junctionMergeDistance);
    const bz = Math.round(point.z / junctionMergeDistance);
    let selected: JunctionCluster | undefined;
    for (let dx = -1; dx <= 1 && !selected; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const clusterId of buckets.get(`${bx + dx},${by + dy},${bz + dz}`) ?? []) {
            const cluster = clusters[clusterId];
            const nonLocal = cluster.occurrences.every((other) => {
              const indexDistance = Math.abs(index - other);
              return Math.min(indexDistance, count - indexDistance) > 8;
            });
            if (!nonLocal) continue;
            if (
              point.distanceToSquared(route.positions[cluster.representative]) <
              junctionMergeDistance * junctionMergeDistance
            ) {
              selected = cluster;
              break;
            }
          }
        }
      }
    }
    if (!selected) {
      selected = { id: clusters.length, representative: index, occurrences: [] };
      clusters.push(selected);
      const pointKey = key(point.x, point.y, point.z);
      const bucket = buckets.get(pointKey) ?? [];
      bucket.push(selected.id);
      buckets.set(pointKey, bucket);
    }
    selected.occurrences.push(index);
    occurrenceClusters.push(selected);
  }

  const nodes: TrafficGraphNode[] = clusters.map((cluster) => ({
    id: cluster.id,
    position: route.positions[cluster.representative].clone(),
    normal: route.normals[cluster.representative].clone(),
    outgoing: [],
    junctionExits: [],
    junctionHasCrossExit: false,
    junctionId: null,
    junctionKind: null,
  }));
  const occurrenceNodes = occurrenceClusters.map((cluster) => nodes[cluster.id]);

  const edges: TrafficGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let totalLength = 0;
  let maxEdgeLength = 0;
  const cumulativeLengths = [0];
  for (let index = 0; index < count; index++) {
    const from = occurrenceNodes[index];
    const to = occurrenceNodes[(index + 1) % count];
    if (from === to) continue;
    const edgeKey = `${from.id}:${to.id}`;
    if (edgeKeys.has(edgeKey)) continue;
    const tangent = to.position.clone().sub(from.position);
    const length = tangent.length();
    if (length < 0.01) continue;
    const edge = {
      id: edges.length,
      from,
      to,
      length,
      tangent: tangent.normalize(),
    } satisfies TrafficGraphEdge;
    edges.push(edge);
    from.outgoing.push(edge);
    edgeKeys.add(edgeKey);
    totalLength += length;
    maxEdgeLength = Math.max(maxEdgeLength, length);
    cumulativeLengths.push(totalLength);
  }
  if (edges.length === 0) throw new Error("Authored traffic route produced no directed edges");
  const incomingCounts = new Map<number, number>();
  for (const edge of edges)
    incomingCounts.set(edge.to.id, (incomingCounts.get(edge.to.id) ?? 0) + 1);
  const junctionZones: Array<{ id: number; representative: THREE.Vector3 }> = [];
  for (const node of nodes) {
    if (node.outgoing.length < 2 && (incomingCounts.get(node.id) ?? 0) < 2) continue;
    let zone = junctionZones.find(
      ({ representative }) => representative.distanceTo(node.position) <= 2.5,
    );
    if (!zone) {
      zone = { id: junctionZones.length, representative: node.position.clone() };
      junctionZones.push(zone);
    }
    node.junctionId = zone.id;
  }
  // Branch samples are sparse along the authored walk. Fill the zone across
  // the local road footprint so a car cannot bypass cooldown by entering the
  // same intersection through an ordinary waypoint between branch samples.
  for (const node of nodes) {
    if (node.junctionId != null) continue;
    const zone = junctionZones.find(
      ({ representative }) => representative.distanceTo(node.position) <= 3.5,
    );
    if (zone) node.junctionId = zone.id;
  }
  const junctionKinds = detectJunctionKinds(nodes);
  for (const node of nodes) {
    if (node.junctionId != null) {
      node.junctionKind = junctionKinds.get(node.junctionId) ?? "intersection";
    }
  }
  // A repeated authored lane can enter an intersection at a slightly
  // different sample than the one that owns the branch. Keep the exact
  // directed edges, but expose nearby exits so navigation can choose the
  // straight/turn option from the physical junction rather than forcing a
  // sharp continuation from one occurrence.
  const crossExitJunctions = new Set<number>();
  for (const edge of edges) {
    if (
      edge.from.junctionId != null &&
      edge.to.junctionId != null &&
      edge.from.junctionId !== edge.to.junctionId
    ) {
      crossExitJunctions.add(edge.from.junctionId);
    }
  }
  const exitBuckets = new Map<string, TrafficGraphEdge[]>();
  const exitBucketKey = (junctionId: number, position: THREE.Vector3) =>
    `${junctionId}:${Math.floor(position.x / TRAFFIC_JUNCTION_EXIT_RADIUS)}:${Math.floor(position.y / TRAFFIC_JUNCTION_EXIT_RADIUS)}:${Math.floor(position.z / TRAFFIC_JUNCTION_EXIT_RADIUS)}`;
  for (const edge of edges) {
    const junctionId = edge.from.junctionId;
    if (junctionId == null || edge.to.junctionId === junctionId) continue;
    const key = exitBucketKey(junctionId, edge.from.position);
    const exits = exitBuckets.get(key) ?? [];
    exits.push(edge);
    exitBuckets.set(key, exits);
  }
  for (const node of nodes) {
    if (node.junctionId == null) {
      node.junctionExits = [];
      node.junctionHasCrossExit = false;
      continue;
    }
    node.junctionHasCrossExit = crossExitJunctions.has(node.junctionId);
    const nearby = new Set<TrafficGraphEdge>();
    const bx = Math.floor(node.position.x / TRAFFIC_JUNCTION_EXIT_RADIUS);
    const by = Math.floor(node.position.y / TRAFFIC_JUNCTION_EXIT_RADIUS);
    const bz = Math.floor(node.position.z / TRAFFIC_JUNCTION_EXIT_RADIUS);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const edge of exitBuckets.get(
            `${node.junctionId}:${bx + dx}:${by + dy}:${bz + dz}`,
          ) ?? []) {
            if (edge.from.position.distanceTo(node.position) <= TRAFFIC_JUNCTION_EXIT_RADIUS)
              nearby.add(edge);
          }
        }
      }
    }
    node.junctionExits = [...nearby];
  }
  return { nodes, edges, cumulativeLengths, totalLength, maxEdgeLength };
}

function horizontalUnit(vector: THREE.Vector3): THREE.Vector3 {
  const result = new THREE.Vector3(vector.x, 0, vector.z);
  return result.lengthSq() > 1e-8 ? result.normalize() : new THREE.Vector3(0, 0, 1);
}

function horizontalDot(first: THREE.Vector3, second: THREE.Vector3): number {
  const firstLength = Math.hypot(first.x, first.z);
  const secondLength = Math.hypot(second.x, second.z);
  if (firstLength < 1e-4 || secondLength < 1e-4) {
    return horizontalUnit(first).dot(horizontalUnit(second));
  }
  return (first.x * second.x + first.z * second.z) / (firstLength * secondLength);
}

/**
 * Return the authored driving turn angle without allowing slope to distort it.
 * A dot product below -0.25 is over 104 degrees and is a U-turn candidate,
 * not an ordinary right/left/straight junction choice.
 */
export function trafficTurnDot(edge: TrafficGraphEdge, candidate: TrafficGraphEdge): number {
  return horizontalDot(edge.tangent, candidate.tangent);
}

export function resolveTrafficMovementTangent(
  previousPosition: THREE.Vector3,
  nextPosition: THREE.Vector3,
  fallbackTangent: THREE.Vector3,
  target: THREE.Vector3,
): THREE.Vector3 {
  target.subVectors(nextPosition, previousPosition);
  if (target.lengthSq() < 1e-8) target.copy(fallbackTangent);
  return target.normalize();
}

const TRAFFIC_FOLLOW_LOOKAHEAD = 8;
const TRAFFIC_FOLLOW_LATERAL_LIMIT = 1.25;
const TRAFFIC_FOLLOW_BUFFER = 0.45;

export function limitTrafficAdvance(
  desiredTravel: number,
  position: THREE.Vector3,
  tangent: THREE.Vector3,
  halfLength: number,
  nearbyCars: readonly TrafficFollowerSample[],
): number {
  let allowedTravel = Math.max(0, desiredTravel);
  const forward = horizontalUnit(tangent);
  for (const other of nearbyCars) {
    const offsetX = other.position.x - position.x;
    const offsetZ = other.position.z - position.z;
    const forwardDistance = offsetX * forward.x + offsetZ * forward.z;
    if (forwardDistance <= 0 || forwardDistance > TRAFFIC_FOLLOW_LOOKAHEAD) continue;
    const lateralX = offsetX - forward.x * forwardDistance;
    const lateralZ = offsetZ - forward.z * forwardDistance;
    if (lateralX * lateralX + lateralZ * lateralZ > TRAFFIC_FOLLOW_LATERAL_LIMIT ** 2) continue;
    if (horizontalDot(tangent, other.tangent) < 0.8) continue;
    const requiredGap = Math.max(1.5, halfLength + other.halfLength + TRAFFIC_FOLLOW_BUFFER);
    allowedTravel = Math.min(allowedTravel, Math.max(0, forwardDistance - requiredGap));
  }
  return allowedTravel;
}

const TRAFFIC_UTURN_DOT_LIMIT = -0.25;
// Authored lane occurrences around the plaza can be several metres apart even
// when they belong to the same physical junction. A sub-metre search misses
// the real exit and leaves only a backward micro-branch to choose from.
const TRAFFIC_JUNCTION_EXIT_RADIUS = 2.5;
const TRAFFIC_MIN_JUNCTION_EXIT_TRAVEL = 0.05;
const trafficCandidateCache = new WeakMap<TrafficGraphEdge, TrafficGraphEdge[]>();

function trafficCandidateEdges(edge: TrafficGraphEdge): TrafficGraphEdge[] {
  const cached = trafficCandidateCache.get(edge);
  if (cached) return cached;
  const directCandidates = edge.to.outgoing.some((candidate) => candidate.id === edge.id)
    ? edge.to.outgoing.filter((candidate) => candidate.id !== edge.id)
    : edge.to.outgoing;
  const directHasForwardTurn = directCandidates.some(
    (candidate) => trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT,
  );
  if (directHasForwardTurn || edge.to.junctionId == null || !edge.to.junctionHasCrossExit) {
    trafficCandidateCache.set(edge, directCandidates);
    return directCandidates;
  }
  // Nearby exits are only added when the exact authored occurrence would
  // force a reversal. They must also cross the authored junction boundary;
  // same-junction duplicates are repeated lane samples and can create a
  // zero-distance ping-pong loop instead of a real road choice.
  const nearbyJunctionExits = edge.to.junctionExits.filter(
    (candidate) =>
      trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT &&
      candidate.to.junctionId !== edge.to.junctionId &&
      candidate.to.position.distanceTo(edge.to.position) >= TRAFFIC_MIN_JUNCTION_EXIT_TRAVEL,
  );
  // Several authored samples can describe the same physical exit. Keep one
  // representative per destination road-space key so navigation does not
  // turn a single branch into a choice between duplicate micro-segments.
  const uniqueNearby = new Map<string, TrafficGraphEdge>();
  for (const candidate of nearbyJunctionExits) {
    const key = `${candidate.to.junctionId ?? "none"}:${trafficSpatialKey(candidate.to)}`;
    const previous = uniqueNearby.get(key);
    if (!previous || trafficTurnDot(edge, candidate) > trafficTurnDot(edge, previous))
      uniqueNearby.set(key, candidate);
  }
  const result = [...new Set([...directCandidates, ...uniqueNearby.values()])].filter(
    (candidate) => candidate.id !== edge.id,
  );
  trafficCandidateCache.set(edge, result);
  return result;
}

function entersSharpJunctionContinuation(candidate: TrafficGraphEdge, junctionId: number): boolean {
  if (candidate.to.junctionId !== junctionId || candidate.to.junctionKind === "roundabout")
    return false;
  const outgoing = candidate.to.outgoing;
  if (outgoing.length === 0) return false;
  return !outgoing.some((next) => trafficTurnDot(candidate, next) >= TRAFFIC_UTURN_DOT_LIMIT);
}

function detectJunctionKinds(
  nodes: readonly TrafficGraphNode[],
): Map<number, Exclude<TrafficJunctionKind, "intersection" | null>> {
  const junctionIds = new Set(
    nodes.map((node) => node.junctionId).filter((id): id is number => id != null),
  );
  const junctionKinds = new Map<number, Exclude<TrafficJunctionKind, "intersection" | null>>();
  for (const junctionId of junctionIds) {
    const zoneNodes = nodes.filter(
      (node) => node.junctionId === junctionId && node.outgoing.length > 1,
    );
    for (const start of zoneNodes) {
      const queue: Array<{
        node: TrafficGraphNode;
        path: TrafficGraphEdge[];
        distance: number;
        visited: Set<number>;
      }> = [{ node: start, path: [], distance: 0, visited: new Set([start.id]) }];
      let cycle: TrafficGraphEdge[] | null = null;
      for (let index = 0; index < queue.length && index < 256 && !cycle; index++) {
        const state = queue[index];
        for (const edge of state.node.outgoing) {
          const nextPath = [...state.path, edge];
          const nextDistance = state.distance + edge.length;
          if (edge.to === start && nextPath.length >= 3 && nextDistance <= 40) {
            cycle = nextPath;
            break;
          }
          if (
            nextPath.length >= 128 ||
            nextDistance > 40 ||
            edge.to.position.distanceTo(start.position) > 12
          )
            continue;
          if (edge.to.junctionId != null && edge.to.junctionId !== junctionId) continue;
          if (state.visited.has(edge.to.id)) continue;
          const visited = new Set(state.visited);
          visited.add(edge.to.id);
          queue.push({ node: edge.to, path: nextPath, distance: nextDistance, visited });
        }
      }
      if (!cycle) {
        break;
      }
      let clockwise = 0;
      let counterClockwise = 0;
      let totalTurn = 0;
      for (let index = 0; index < cycle.length; index++) {
        const first = cycle[index].tangent;
        const second = cycle[(index + 1) % cycle.length].tangent;
        const firstLength = Math.hypot(first.x, first.z);
        const secondLength = Math.hypot(second.x, second.z);
        const cross =
          firstLength < 1e-4 || secondLength < 1e-4
            ? 0
            : (first.x * second.z - first.z * second.x) / (firstLength * secondLength);
        if (cross > 1e-5) clockwise++;
        else if (cross < -1e-5) counterClockwise++;
        totalTurn += Math.acos(Math.max(-1, Math.min(1, horizontalDot(first, second))));
      }
      const dominantTurns = Math.max(clockwise, counterClockwise);
      // A circulation loop has a consistent rotation direction and roughly a
      // full revolution. Mixed-sign junction loops are ordinary intersections.
      const strictCircle =
        dominantTurns >= 4 && dominantTurns / cycle.length >= 0.75 && totalTurn >= 4.5;
      if (strictCircle) {
        junctionKinds.set(junctionId, "roundabout");
        break;
      }
    }
  }
  return junctionKinds;
}

function findGraphEdge(graph: AuthoredTrafficGraph, distance: number): TrafficGraphEdge {
  let low = 0;
  let high = graph.edges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (distance < graph.cumulativeLengths[middle]) high = middle - 1;
    else if (distance >= graph.cumulativeLengths[middle + 1]) low = middle + 1;
    else return graph.edges[middle];
  }
  return graph.edges.at(-1)!;
}

function junctionExitDistance(
  start: TrafficGraphNode,
  junctionId: number,
  recentJunctionIds?: ReadonlySet<number>,
): number {
  if (start.junctionId !== junctionId) {
    return start.junctionId == null || !recentJunctionIds?.has(start.junctionId) ? 0 : Infinity;
  }
  const queue: Array<{ node: TrafficGraphNode; distance: number }> = [{ node: start, distance: 0 }];
  const visited = new Set<number>();
  for (let index = 0; index < queue.length && index < 256; index++) {
    const { node, distance } = queue[index];
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    for (const outgoing of node.outgoing) {
      if (outgoing.to.junctionId !== junctionId) {
        if (outgoing.to.junctionId == null || !recentJunctionIds?.has(outgoing.to.junctionId))
          return distance + 1;
        continue;
      }
      if (!visited.has(outgoing.to.id)) queue.push({ node: outgoing.to, distance: distance + 1 });
    }
  }
  return Infinity;
}

function freshPathDepth(
  start: TrafficGraphEdge,
  recentEdgeIds: ReadonlySet<number>,
  recentSpatialKeys: ReadonlySet<string>,
): number {
  if (recentSpatialKeys.has(trafficSpatialKey(start.to))) return 0;
  const queue: Array<{ edge: TrafficGraphEdge; depth: number }> = [{ edge: start, depth: 1 }];
  const visited = new Set<number>();
  let maxDepth = 0;
  for (let index = 0; index < queue.length && index < 256; index++) {
    const { edge, depth } = queue[index];
    if (visited.has(edge.id) || recentEdgeIds.has(edge.id)) continue;
    visited.add(edge.id);
    maxDepth = Math.max(maxDepth, depth);
    for (const outgoing of edge.to.outgoing) {
      if (
        !recentEdgeIds.has(outgoing.id) &&
        !recentSpatialKeys.has(trafficSpatialKey(outgoing.to)) &&
        !visited.has(outgoing.id)
      ) {
        queue.push({ edge: outgoing, depth: depth + 1 });
      }
    }
  }
  return maxDepth;
}

// The default traffic range tops out at 26 km/h. A route cycle that closes
// within this distance can keep a car in the same local area for a second at
// the configured live speed, so branch selection must reject it.
const ONE_SECOND_TRAFFIC_DISTANCE = 26 / 3.6;
const SHORT_TRAFFIC_CYCLE_EDGE_LIMIT = 12;
const SPATIAL_TRAFFIC_CYCLE_EDGE_LIMIT = 64;
const LOCAL_TRAFFIC_EDGE_HISTORY_LIMIT = 64;
const TRAFFIC_ROUNDABOUT_COOLDOWN_DISTANCE = 24;

function roundaboutStateForEdge(edge: TrafficGraphEdge): TrafficRoundaboutState | null {
  if (edge.to.junctionKind == null || edge.to.junctionId == null) return null;
  return {
    junctionId: edge.to.junctionId,
    junctionKind: edge.to.junctionKind,
    phase: "inside",
    seenEdgeIds: new Set([edge.id]),
    cooldownDistance: 0,
  };
}

function updateRoundaboutState(
  state: TrafficRoundaboutState | null,
  previous: TrafficGraphEdge,
  next: TrafficGraphEdge,
): TrafficRoundaboutState | null {
  const nextJunctionId = next.to.junctionKind != null ? next.to.junctionId : null;
  const previousJunctionId = previous.to.junctionId;
  const nextJunctionKind = next.to.junctionKind;
  if (nextJunctionId == null) {
    if (
      previousJunctionId != null &&
      state?.junctionId === previousJunctionId &&
      state.phase === "inside"
    ) {
      return { ...state, phase: "cooldown", cooldownDistance: 0 };
    }
    return state;
  }
  if (nextJunctionKind == null || next.to.junctionId == null) return state;
  if (state?.junctionId === next.to.junctionId && state.phase === "inside") {
    state.seenEdgeIds.add(next.id);
    return state;
  }
  return {
    junctionId: next.to.junctionId,
    junctionKind: nextJunctionKind,
    phase: "inside",
    seenEdgeIds: new Set([next.id]),
    cooldownDistance: 0,
  };
}

/**
 * Return the shortest path from a candidate back into the car's recent edge
 * or road-space history. The search covers one second of travel for spatial
 * loops and twelve local edges for compact authored cycles. The spatial search
 * needs a larger edge budget because the authored route contains very short
 * samples around junctions and roundabouts.
 */
function shortestRecentCycleDistance(
  start: TrafficGraphEdge,
  recentEdgeIds: readonly number[],
  recentSpatialKeys: ReadonlySet<string>,
): { edgeCycleSteps: number; spatialDistance: number } {
  type SearchState = { edge: TrafficGraphEdge; distance: number; steps: number };
  const queue: SearchState[] = [{ edge: start, distance: start.length, steps: 1 }];
  const bestDistance = new Map<number, number>();
  let shortestEdgeCycleSteps = Infinity;
  let shortestSpatialDistance = Infinity;
  for (let index = 0; index < queue.length && index < 128; index++) {
    let nextIndex = index;
    for (let candidateIndex = index + 1; candidateIndex < queue.length; candidateIndex++) {
      if (queue[candidateIndex].distance < queue[nextIndex].distance) nextIndex = candidateIndex;
    }
    if (nextIndex !== index) {
      const state = queue[index];
      queue[index] = queue[nextIndex];
      queue[nextIndex] = state;
    }
    const { edge, distance, steps } = queue[index];
    if (steps <= SHORT_TRAFFIC_CYCLE_EDGE_LIMIT) {
      const previousUse = recentEdgeIds.lastIndexOf(edge.id);
      const edgeCycleSteps =
        previousUse < 0 ? Infinity : recentEdgeIds.length - previousUse + steps - 1;
      if (edgeCycleSteps <= SHORT_TRAFFIC_CYCLE_EDGE_LIMIT) {
        shortestEdgeCycleSteps = Math.min(shortestEdgeCycleSteps, edgeCycleSteps);
        continue;
      }
    }
    if (
      distance <= ONE_SECOND_TRAFFIC_DISTANCE &&
      recentSpatialKeys.has(trafficSpatialKey(edge.to))
    ) {
      shortestSpatialDistance = Math.min(shortestSpatialDistance, distance);
    }
    if (distance >= ONE_SECOND_TRAFFIC_DISTANCE || steps >= SPATIAL_TRAFFIC_CYCLE_EDGE_LIMIT)
      continue;
    const previousDistance = bestDistance.get(edge.id);
    if (previousDistance != null && previousDistance <= distance) continue;
    bestDistance.set(edge.id, distance);
    for (const outgoing of edge.to.outgoing) {
      if (outgoing.to === edge.from) continue;
      const nextDistance = distance + outgoing.length;
      if (nextDistance <= ONE_SECOND_TRAFFIC_DISTANCE) {
        queue.push({ edge: outgoing, distance: nextDistance, steps: steps + 1 });
      }
    }
  }
  return { edgeCycleSteps: shortestEdgeCycleSteps, spatialDistance: shortestSpatialDistance };
}

export function chooseNextTrafficEdge(
  edge: TrafficGraphEdge,
  recentEdgeIds: readonly number[],
  recentSpatialKeys: readonly string[],
  random = Math.random,
  recentJunctionIds: readonly number[] = [],
  onDecision?: (event: TrafficDecisionEvent) => void,
  roundaboutState: TrafficRoundaboutState | null = null,
): TrafficGraphEdge | null {
  const emitDecision = (
    next: TrafficGraphEdge | null,
    reason: TrafficDecisionReason,
    rejectedUTurns: Array<{ edgeId: number; turnDot: number }> = [],
  ) => {
    if (!onDecision) return;
    onDecision({
      edgeId: edge.id,
      nextEdgeId: next?.id ?? null,
      junctionId: edge.to.junctionId,
      turnDot: next ? trafficTurnDot(edge, next) : null,
      reason,
      rejectedUTurns,
    });
  };
  const allCandidates = trafficCandidateEdges(edge);
  let candidates = allCandidates;
  if (candidates.length === 0) {
    emitDecision(null, "no-legal-turn");
    return null;
  }
  const currentJunctionId = edge.to.junctionId;
  const recentJunctions = new Set(recentJunctionIds);
  // Only the compact local history should suppress a branch. A lane can
  // legitimately revisit an authored edge after travelling across the map;
  // treating the full retention buffer as "used" forces cars onto a nearby
  // detour that may itself be a closed loop. The local window covers the
  // maximum one-second travel distance on Isla's densely sampled route.
  const recentEdges = new Set(recentEdgeIds.slice(-LOCAL_TRAFFIC_EDGE_HISTORY_LIMIT));
  const recent = new Set(recentSpatialKeys.slice(-LOCAL_TRAFFIC_EDGE_HISTORY_LIMIT));
  // The next authored waypoint can share the current endpoint's coarse
  // spatial bucket on dense junction samples. Treat that as fresh only when
  // it continues forward; a same-bucket reversal remains suppressed.
  const isFreshCandidate = (candidate: TrafficGraphEdge) =>
    !recentEdges.has(candidate.id) &&
    (!recent.has(trafficSpatialKey(candidate.to)) ||
      trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT);
  const freshCandidates = candidates.filter(isFreshCandidate);
  if (freshCandidates.length > 0) candidates = freshCandidates;
  const hasFreshForwardCandidate = candidates.some(
    (candidate) =>
      trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT && isFreshCandidate(candidate),
  );
  const authoredForwardCandidates = allCandidates.filter(
    (candidate) => trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT,
  );
  if (!hasFreshForwardCandidate && authoredForwardCandidates.length > 0) {
    // Keep a car facing the road even when the forward occurrence is recent;
    // the local cycle guard below will reject it if it would re-enter a loop.
    candidates = authoredForwardCandidates;
  }
  if (
    !hasFreshForwardCandidate &&
    candidates.some((candidate) => trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT)
  ) {
    // If every nearby forward exit immediately returns to the car's recent
    // road-space, keep the direct authored arcs and classify a sharp one as a
    // dead-end fallback. A stale cross-junction exit must not force a loop.
    const directCandidates = candidates.filter((candidate) => edge.to.outgoing.includes(candidate));
    if (
      directCandidates.length > 0 &&
      !directCandidates.some(
        (candidate) => trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT,
      )
    ) {
      candidates = directCandidates;
    }
  }
  const noImmediateReverse = candidates.filter((candidate) => candidate.to !== edge.from);
  const previousSpatialKey = trafficSpatialKey(edge.from);
  const noSpatialReverse = noImmediateReverse.filter(
    (candidate) =>
      trafficSpatialKey(candidate.to) !== previousSpatialKey ||
      trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT,
  );
  if (noSpatialReverse.length > 0) candidates = noSpatialReverse;
  else if (noImmediateReverse.length > 0) candidates = noImmediateReverse;
  if (edge.to.junctionKind === "roundabout" && currentJunctionId != null) {
    const hasVisitedRoundaboutArc = candidates.some(
      (candidate) =>
        candidate.to.junctionId === currentJunctionId &&
        (recentEdges.has(candidate.id) || recent.has(trafficSpatialKey(candidate.to))),
    );
    if (hasVisitedRoundaboutArc) {
      const exits = candidates.filter((candidate) => candidate.to.junctionId !== currentJunctionId);
      if (exits.length > 0) candidates = exits;
    }
  }
  if (roundaboutState?.phase === "inside" && roundaboutState.junctionId === currentJunctionId) {
    const unvisited = candidates.filter(
      (candidate) => !roundaboutState.seenEdgeIds.has(candidate.id),
    );
    if (unvisited.length > 0) candidates = unvisited;
  }
  if (roundaboutState?.phase === "cooldown" && edge.to.junctionKind !== "roundabout") {
    const reentrySafe = candidates.filter(
      (candidate) =>
        candidate.to.junctionId !== roundaboutState.junctionId ||
        candidate.to.junctionKind !== "roundabout",
    );
    if (reentrySafe.length > 0) candidates = reentrySafe;
    else {
      emitDecision(null, "no-legal-turn");
      return null;
    }
  }
  const noImmediateRoundaboutReentry = candidates.filter(
    (candidate) =>
      edge.to.junctionKind === "roundabout" ||
      candidate.to.junctionKind !== "roundabout" ||
      candidate.to.junctionId == null ||
      !recentJunctions.has(candidate.to.junctionId),
  );
  if (noImmediateRoundaboutReentry.length > 0) candidates = noImmediateRoundaboutReentry;
  else {
    emitDecision(null, "no-legal-turn");
    return null;
  }
  // Do not enter a same-junction branch whose very next authored segment is
  // already a sharp reversal when another exit stays on the road. These are
  // repeated intersection samples in the Isla lane asset, not valid turns;
  // allowing them commits a car to a short local loop before it can reach the
  // real cross-junction exit.
  if (currentJunctionId != null && edge.to.junctionKind !== "roundabout" && candidates.length > 1) {
    const stableCandidates = candidates.filter(
      (candidate) => !entersSharpJunctionContinuation(candidate, currentJunctionId),
    );
    const stableForwardCandidates = stableCandidates.filter(
      (candidate) => trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT,
    );
    const forwardCandidates = candidates.filter(
      (candidate) => trafficTurnDot(edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT,
    );
    if (stableForwardCandidates.length > 0) candidates = stableForwardCandidates;
    else if (forwardCandidates.length > 0) candidates = forwardCandidates;
    else if (stableCandidates.length > 0) candidates = stableCandidates;
  }
  const candidateTurns = candidates.map((candidate) => ({
    candidate,
    turnDot: trafficTurnDot(edge, candidate),
  }));
  const hasForwardTurn = candidateTurns.some(({ turnDot }) => turnDot >= TRAFFIC_UTURN_DOT_LIMIT);
  const legalTurnCandidates = candidateTurns
    .filter(
      ({ candidate, turnDot }) =>
        turnDot >= TRAFFIC_UTURN_DOT_LIMIT ||
        (roundaboutState?.phase === "inside" &&
          roundaboutState.junctionId === currentJunctionId &&
          !roundaboutState.seenEdgeIds.has(candidate.id)) ||
        (currentJunctionId == null &&
          candidates.length === 1 &&
          !recentEdgeIds.includes(candidate.id) &&
          candidate.to.outgoing.some(
            (next) => trafficTurnDot(candidate, next) >= TRAFFIC_UTURN_DOT_LIMIT,
          )),
    )
    .map(({ candidate }) => candidate);
  const rejectedUTurns = candidateTurns
    .filter(
      ({ candidate, turnDot }) =>
        turnDot < TRAFFIC_UTURN_DOT_LIMIT && !legalTurnCandidates.includes(candidate),
    )
    .map(({ candidate, turnDot }) => ({ edgeId: candidate.id, turnDot }));
  if (legalTurnCandidates.length > 0) {
    candidates = legalTurnCandidates;
  } else {
    emitDecision(null, "no-legal-turn", rejectedUTurns);
    return null;
  }
  const novelEdges = candidates.filter((candidate) => !recentEdges.has(candidate.id));
  if (novelEdges.length > 0) {
    candidates = novelEdges;
  }
  let cycleForced = false;
  if (candidates.length > 1) {
    const cycleScores = candidates.map((candidate) => ({
      candidate,
      score: shortestRecentCycleDistance(candidate, recentEdgeIds, recent),
    }));
    const safeCandidates = cycleScores
      .filter(
        ({ score }) =>
          score.edgeCycleSteps > SHORT_TRAFFIC_CYCLE_EDGE_LIMIT &&
          score.spatialDistance > ONE_SECOND_TRAFFIC_DISTANCE,
      )
      .map(({ candidate }) => candidate);
    if (safeCandidates.length > 0) {
      candidates = safeCandidates;
    } else {
      cycleForced = true;
      const bestEdgeCycleSteps = Math.max(...cycleScores.map(({ score }) => score.edgeCycleSteps));
      const edgeCycleCandidates = cycleScores.filter(
        ({ score }) => score.edgeCycleSteps === bestEdgeCycleSteps,
      );
      const bestSpatialDistance = Math.max(
        ...edgeCycleCandidates.map(({ score }) => score.spatialDistance),
      );
      candidates = edgeCycleCandidates
        .filter(({ score }) => score.spatialDistance === bestSpatialDistance)
        .map(({ candidate }) => candidate);
    }
  }
  const decisionReason = (next: TrafficGraphEdge | null): TrafficDecisionReason => {
    if (!next || trafficTurnDot(edge, next) >= TRAFFIC_UTURN_DOT_LIMIT) return "normal";
    if (edge.to.junctionKind === "roundabout") return "roundabout";
    return !hasForwardTurn ? "dead-end" : "normal";
  };
  if (cycleForced) {
    const next = candidates[Math.floor(random() * candidates.length)] ?? null;
    emitDecision(next, decisionReason(next), rejectedUTurns);
    return next;
  }
  if (currentJunctionId != null && candidates.length > 1) {
    const freshExitScores = candidates.map((candidate) => ({
      candidate,
      distance: junctionExitDistance(candidate.to, currentJunctionId, recentJunctions),
    }));
    const bestFreshExitDistance = Math.min(...freshExitScores.map(({ distance }) => distance));
    if (Number.isFinite(bestFreshExitDistance)) {
      candidates = freshExitScores
        .filter(({ distance }) => distance === bestFreshExitDistance)
        .map(({ candidate }) => candidate);
    } else {
      const exitScores = candidates.map((candidate) => ({
        candidate,
        distance: junctionExitDistance(candidate.to, currentJunctionId),
      }));
      const bestExitDistance = Math.min(...exitScores.map(({ distance }) => distance));
      if (Number.isFinite(bestExitDistance)) {
        candidates = exitScores
          .filter(({ distance }) => distance === bestExitDistance)
          .map(({ candidate }) => candidate);
      }
    }
  }
  if (candidates.length > 1) {
    // Repeated authored passes can represent the same roundabout arc with
    // slightly different samples. Prefer a branch with a long fresh path,
    // then one that stays farthest from recently visited road space. This
    // breaks short circles without rejecting legitimate authored turns.
    const cycleDistances = new Map<number, number>();
    const distanceToRecentSpace = (start: TrafficGraphEdge): number => {
      const queue: Array<{ edge: TrafficGraphEdge; depth: number }> = [{ edge: start, depth: 1 }];
      const seen = new Set<number>();
      for (let index = 0; index < queue.length && index < 48; index++) {
        const { edge: current, depth } = queue[index];
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        if (recent.has(trafficSpatialKey(current.to))) return depth;
        for (const outgoing of current.to.outgoing) {
          if (!seen.has(outgoing.id)) queue.push({ edge: outgoing, depth: depth + 1 });
        }
      }
      return Infinity;
    };
    const cachedDistanceToRecentSpace = (start: TrafficGraphEdge): number => {
      const cached = cycleDistances.get(start.id);
      if (cached != null) return cached;
      const distance = distanceToRecentSpace(start);
      cycleDistances.set(start.id, distance);
      return distance;
    };
    const noveltyDistance = (start: TrafficGraphEdge): number => {
      const queue: Array<{ edge: TrafficGraphEdge; depth: number }> = [{ edge: start, depth: 0 }];
      const seen = new Set<number>([start.id]);
      for (let index = 0; index < queue.length && index < 24; index++) {
        const current = queue[index];
        if (!recent.has(trafficSpatialKey(current.edge.to))) return current.depth;
        for (const outgoing of current.edge.to.outgoing) {
          if (seen.has(outgoing.id)) continue;
          seen.add(outgoing.id);
          queue.push({ edge: outgoing, depth: current.depth + 1 });
        }
      }
      return Infinity;
    };
    const scored = candidates.map((candidate) => ({
      candidate,
      depth: freshPathDepth(candidate, recentEdges, recent),
      distance: noveltyDistance(candidate),
    }));
    const bestDepth = Math.max(...scored.map(({ depth }) => depth));
    const deepEnough = scored.filter(({ depth }) => depth >= bestDepth - 8);
    const bestCycleDistance = Math.max(
      ...deepEnough.map(({ candidate }) => cachedDistanceToRecentSpace(candidate)),
    );
    const deepest = deepEnough.filter(
      ({ candidate }) => cachedDistanceToRecentSpace(candidate) === bestCycleDistance,
    );
    const bestDistance = Math.min(...deepest.map(({ distance }) => distance));
    const novel = deepest
      .filter(({ distance }) => distance === bestDistance)
      .map(({ candidate }) => candidate);
    if (novel.length > 0) candidates = novel;
  }
  if (candidates.length === 1 && candidates[0].to.junctionKind !== "roundabout") {
    const candidate = candidates[0];
    const repeatsRecentPath = recentEdges.has(candidate.id);
    const cycle = repeatsRecentPath
      ? shortestRecentCycleDistance(candidate, recentEdgeIds, recent)
      : null;
    if (
      cycle &&
      (cycle.edgeCycleSteps <= SHORT_TRAFFIC_CYCLE_EDGE_LIMIT ||
        cycle.spatialDistance <= ONE_SECOND_TRAFFIC_DISTANCE)
    ) {
      emitDecision(null, "no-legal-turn", rejectedUTurns);
      return null;
    }
  }
  const next = candidates[Math.floor(random() * candidates.length)] ?? null;
  emitDecision(next, decisionReason(next), rejectedUTurns);
  return next;
}

export function trafficSpatialKey(node: TrafficGraphNode): string {
  return `${Math.round(node.position.x / 0.2)},${Math.round(node.position.y / 0.2)},${Math.round(node.position.z / 0.2)}`;
}

export function selectActiveColliderIndices(
  positions: readonly THREE.Vector3[],
  playerPosition: THREE.Vector3,
  radius: number,
  limit: number,
): Set<number> {
  const radiusSq = radius * radius;
  return new Set(
    positions
      .map((position, index) => ({ index, distanceSq: position.distanceToSquared(playerPosition) }))
      .filter(({ distanceSq }) => distanceSq <= radiusSq)
      .sort((a, b) => a.distanceSq - b.distanceSq)
      .slice(0, Math.max(0, limit))
      .map(({ index }) => index),
  );
}

export function reconcileActiveIndices(
  current: Set<number>,
  desired: ReadonlySet<number>,
  activate: (index: number) => void,
  deactivate: (index: number) => void,
): void {
  for (const index of current) {
    if (!desired.has(index)) {
      deactivate(index);
      current.delete(index);
    }
  }
  for (const index of desired) {
    if (!current.has(index)) {
      activate(index);
      current.add(index);
    }
  }
}

export function disposeUniqueMeshResources(root: THREE.Object3D | readonly THREE.Object3D[]): {
  geometries: number;
  materials: number;
  textures: number;
} {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const roots: readonly THREE.Object3D[] = Array.isArray(root) ? root : [root as THREE.Object3D];
  for (const objectRoot of roots) {
    objectRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
  }
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
  return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}

function detectTrafficTier(): "high" | "standard" | "low" {
  if (typeof navigator === "undefined") return "high";
  const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (mobile || cores <= 4 || memory <= 4) return "low";
  if (cores <= 8 || memory <= 6) return "standard";
  return "high";
}

export function resolveTrafficProfile(
  config: TrafficConfig,
  detectedTier: "high" | "standard" | "low",
) {
  const tier = config.deviceTier ?? detectedTier;
  const requestedCount = config.count ?? Math.min(8, config.modelUrls.length);
  return {
    tier,
    count: tier === "low" ? Math.min(requestedCount, config.lowTierCount ?? 10) : requestedCount,
    collisionRadius:
      tier === "low" ? (config.lowTierCollisionRadius ?? 70) : (config.collisionRadius ?? 90),
    maxActiveColliders:
      tier === "low"
        ? (config.lowTierMaxActiveColliders ?? 4)
        : (config.maxActiveColliders ?? Math.min(12, requestedCount)),
  };
}

function parseTrack(
  raw: unknown,
  trackUrl: string,
  requestedSide: TrackLaneSide,
): {
  routes: ClosedTrafficRoute[];
  junctionMergeDistance: number;
} {
  const definition: TrafficTrackDefinition = Array.isArray(raw)
    ? { version: 1, centerline: raw as TrackPoint[], trafficSide: requestedSide }
    : (raw as TrafficTrackDefinition);
  const centerline = definition?.centerline;
  if (!definition || !Array.isArray(centerline))
    throw new Error(`Track ${trackUrl} must contain a centerline array`);
  const lanes =
    definition.lanes?.filter((lane) => lane.side === requestedSide && (lane.closed ?? true)) ?? [];
  const selected =
    lanes.length > 0
      ? lanes
      : [
          {
            id: "legacy-route",
            side: requestedSide,
            direction: "forward" as const,
            closed: true,
            points: centerline,
          },
        ];
  const junctionMergeDistance = definition.junctionMergeDistance ?? 0.08;
  if (!Number.isFinite(junctionMergeDistance) || junctionMergeDistance <= 0) {
    throw new Error(`Track ${trackUrl} must declare a positive junctionMergeDistance`);
  }
  const routes = selected.map((lane) => {
    const points = lane.points ?? centerline;
    if (
      points.length < 3 ||
      points.some(
        (point) =>
          !Array.isArray(point) ||
          (point.length !== 3 && point.length !== 6) ||
          point.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error(`Track ${trackUrl} lane ${lane.id} contains invalid waypoints`);
    }
    if (Math.abs(lane.laneOffset ?? 0) > 1e-6)
      throw new Error(`Track ${trackUrl} lane ${lane.id} must contain authoritative lane points`);
    return buildClosedRoute(points, lane.direction === "reverse");
  });
  return { routes, junctionMergeDistance };
}

export async function createTraffic(
  scene: THREE.Scene,
  camera: THREE.Camera,
  config: TrafficConfig,
): Promise<Traffic> {
  const group = new THREE.Group();
  group.name = "Traffic";
  scene.add(group);

  const [trackRes, loadedModels] = await Promise.all([
    fetch(config.trackUrl).then((response) => {
      if (!response.ok)
        throw new Error(`Failed to load traffic track ${config.trackUrl}: ${response.status}`);
      return response.json() as Promise<unknown>;
    }),
    Promise.all(
      config.modelUrls.map((url) => {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        return loader.loadAsync(url);
      }),
    ),
  ]);
  const { routes, junctionMergeDistance } = parseTrack(
    trackRes,
    config.trackUrl,
    config.laneSide ?? "right",
  );
  const graphs = routes.map((route) => buildAuthoredTrafficGraph(route, junctionMergeDistance));
  for (const graph of graphs) applyTrafficRoundaboutZones(graph, config.roundaboutZones ?? []);
  const { count, collisionRadius, maxActiveColliders } = resolveTrafficProfile(
    config,
    detectTrafficTier(),
  );
  const debugDecisions =
    config.debugDecisions ??
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("trafficDebug"));
  const onTrafficDecision = debugDecisions
    ? (
        event: TrafficDecisionEvent & { carIndex?: number; modelUrl?: string; position?: number[] },
      ) => {
        if (event.reason === "normal" && event.rejectedUTurns.length === 0) return;
        console.info("[Agent HQ] traffic decision", JSON.stringify(event));
      }
    : undefined;
  const speedRange = config.speedRange ?? [18, 26];
  const totalRouteLength = graphs.reduce((sum, graph) => sum + graph.totalLength, 0);
  const roundaboutJunctionIds = new Set(
    graphs.flatMap((graph) =>
      graph.nodes
        .filter((node) => node.junctionKind === "roundabout" && node.junctionId != null)
        .map((node) => node.junctionId as number),
    ),
  );
  const cars_: TrafficCar[] = [];
  const spawnPositions: THREE.Vector3[] = [];
  const samplePosition = new THREE.Vector3();
  const sampleTangent = new THREE.Vector3();
  const sampleNormal = new THREE.Vector3();
  const loggedModels = new Set<string>();

  const chooseGraph = () => {
    let distance = Math.random() * totalRouteLength;
    for (const graph of graphs) {
      if (distance < graph.totalLength) return graph;
      distance -= graph.totalLength;
    }
    return graphs.at(-1)!;
  };
  const randomEdge = (allowRoundabout = false) => {
    let fallback: TrafficGraphEdge | null = null;
    for (let attempt = 0; attempt < 32; attempt++) {
      const graph = chooseGraph();
      const edge = findGraphEdge(graph, Math.random() * graph.totalLength);
      fallback ??= edge;
      if (allowRoundabout || edge.to.junctionKind !== "roundabout") return edge;
    }
    return fallback!;
  };
  const sampleEdge = (edge: TrafficGraphEdge, edgeDistance: number) => {
    const t = Math.min(1, Math.max(0, edgeDistance / edge.length));
    samplePosition.lerpVectors(edge.from.position, edge.to.position, t);
    sampleTangent.copy(edge.tangent);
    sampleNormal.lerpVectors(edge.from.normal, edge.to.normal, t).normalize();
    if (sampleNormal.y < 0) sampleNormal.negate();
  };

  const recoverCarRoute = (car: TrafficCar): boolean => {
    const recentlyVisitedRoundabouts = new Set(
      car.recentJunctionIds.filter((id) => roundaboutJunctionIds.has(id)),
    );
    if (car.edge.to.junctionKind === "roundabout" && car.edge.to.junctionId != null) {
      recentlyVisitedRoundabouts.add(car.edge.to.junctionId);
    }
    const graph = graphs.find((candidate) => candidate.edges.includes(car.edge));
    const currentJunctionId = car.edge.to.junctionId;
    const nearbyForward =
      graph?.edges
        .filter(
          (candidate) =>
            candidate !== car.edge &&
            !car.recentEdgeIds.includes(candidate.id) &&
            car.edge.to.position.distanceTo(candidate.from.position) <=
              TRAFFIC_JUNCTION_EXIT_RADIUS &&
            trafficTurnDot(car.edge, candidate) >= TRAFFIC_UTURN_DOT_LIMIT &&
            candidate.to.junctionKind !== "roundabout" &&
            (currentJunctionId != null
              ? candidate.to.junctionId !== currentJunctionId
              : candidate.from.position.distanceTo(car.edge.to.position) <=
                TRAFFIC_MIN_JUNCTION_EXIT_TRAVEL) &&
            (candidate.to.junctionId == null ||
              !recentlyVisitedRoundabouts.has(candidate.to.junctionId)),
        )
        .sort(
          (left, right) =>
            left.from.position.distanceToSquared(car.edge.to.position) -
            right.from.position.distanceToSquared(car.edge.to.position),
        )[0] ?? null;
    const replacement =
      nearbyForward ??
      graph?.edges
        .filter(
          (candidate) =>
            candidate !== car.edge &&
            !car.recentEdgeIds.includes(candidate.id) &&
            candidate.to.junctionKind !== "roundabout" &&
            candidate.from.position.distanceTo(car.edge.to.position) <= 8 &&
            (candidate.to.junctionId == null ||
              !recentlyVisitedRoundabouts.has(candidate.to.junctionId)),
        )
        .sort(
          (left, right) =>
            left.from.position.distanceToSquared(car.edge.to.position) -
            right.from.position.distanceToSquared(car.edge.to.position),
        )[0] ??
      null;
    if (!replacement) {
      if (car.edge.to.junctionKind === "roundabout" && car.roundaboutState?.phase === "inside") {
        car.roundaboutState = { ...car.roundaboutState, phase: "cooldown", cooldownDistance: 0 };
      }
      car.stalled = true;
      car.edgeDistance = car.edge.length;
      return false;
    }
    const previous = car.edge;
    car.edge = replacement;
    car.edgeDistance = 0;
    car.roundaboutState = updateRoundaboutState(car.roundaboutState, previous, replacement);
    car.recentEdgeIds = [replacement.id];
    car.recentSpatialKeys = [
      trafficSpatialKey(replacement.from),
      trafficSpatialKey(replacement.to),
    ];
    car.recentJunctionIds = [
      ...recentlyVisitedRoundabouts,
      replacement.from.junctionId,
      replacement.to.junctionId,
    ].filter((id, index, values): id is number => id != null && values.indexOf(id) === index);
    return true;
  };

  for (let i = 0; i < count; i++) {
    const modelIndex = i % loadedModels.length;
    const car = loadedModels[modelIndex].scene.clone(true);
    car.traverse((object) => {
      const name = object.name ?? "";
      if (/^Cube\.047$|^Cube\.082$|^Sphere019/.test(name)) object.visible = false;
      else if (object instanceof THREE.Mesh) {
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        if (material && /Yacht/.test(material.name)) object.visible = false;
      }
    });
    const pivot = new THREE.Group();
    pivot.add(car);
    const bounds = new THREE.Box3().setFromObject(car);
    const size = bounds.getSize(new THREE.Vector3());
    const sourceLength = Math.max(size.x, size.z);
    const modelUrl = config.modelUrls[modelIndex];
    const modelForwardAxis = config.modelForwardAxes?.[modelUrl] ?? "+X";
    const modelYawOffset =
      resolveTrafficModelYawOffset(modelForwardAxis) + (config.modelYawOffsets?.[modelUrl] ?? 0);
    const targetLength = config.modelTargetLengths?.[modelUrl];
    const scale =
      targetLength && targetLength > 0 && sourceLength > 1e-6 ? targetLength / sourceLength : 0.5;
    if (debugDecisions && !loggedModels.has(modelUrl)) {
      loggedModels.add(modelUrl);
      console.info(
        "[Agent HQ] traffic model",
        JSON.stringify({
          modelUrl,
          sourceLength,
          targetLength: targetLength ?? null,
          scale,
          localForwardAxis: modelForwardAxis,
          yawOffset: modelYawOffset,
        }),
      );
    }
    pivot.scale.setScalar(scale);
    const center = bounds.getCenter(new THREE.Vector3());
    car.position.sub(center);
    car.rotation.y = modelYawOffset;
    const groundOffset = (center.y - bounds.min.y) * scale;
    const halfExtents = size.multiplyScalar(scale * 0.5);
    const speed = (speedRange[0] + Math.random() * (speedRange[1] - speedRange[0])) / 3.6;
    let edge = randomEdge();
    let edgeDistance = Math.random() * edge.length;
    for (let attempt = 0; attempt < 48; attempt++) {
      const candidateEdge = randomEdge();
      const candidateDistance = Math.random() * candidateEdge.length;
      sampleEdge(candidateEdge, candidateDistance);
      if (spawnPositions.every((position) => position.distanceToSquared(samplePosition) >= 25)) {
        edge = candidateEdge;
        edgeDistance = candidateDistance;
        break;
      }
    }
    sampleEdge(edge, edgeDistance);
    spawnPositions.push(samplePosition.clone());
    cars_.push({
      group: pivot,
      debugIndex: i,
      modelUrl: config.modelUrls[modelIndex],
      edge,
      edgeDistance,
      recentEdgeIds: [edge.id],
      recentSpatialKeys: [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)],
      recentJunctionIds: [edge.from.junctionId, edge.to.junctionId].filter(
        (id): id is number => id != null,
      ),
      roundaboutState: roundaboutStateForEdge(edge),
      speed,
      groundOffset,
      halfExtents,
      body: null,
      stalled: false,
    });
    group.add(pivot);
  }

  let physicsWorld: RapierWorld | null = null;
  const activeColliderIndices = new Set<number>();
  const activateCollider = (index: number) => {
    if (!physicsWorld || cars_[index].body) return;
    const car = cars_[index];
    const bodyDesc = RAPIER.RigidBodyDesc.newKinematicPositionBased().setTranslation(
      car.group.position.x,
      car.group.position.y,
      car.group.position.z,
    );
    car.body = physicsWorld.createRigidBody(bodyDesc);
    physicsWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(
        car.halfExtents.x,
        car.halfExtents.y,
        car.halfExtents.z,
      ).setFriction(0.6),
      car.body,
    );
  };
  const deactivateCollider = (index: number) => {
    const car = cars_[index];
    if (physicsWorld && car.body) physicsWorld.removeRigidBody(car.body);
    car.body = null;
  };
  const attachPhysics = (world: RapierWorld) => {
    if (physicsWorld === world) return;
    if (physicsWorld)
      reconcileActiveIndices(
        activeColliderIndices,
        new Set(),
        activateCollider,
        deactivateCollider,
      );
    physicsWorld = world;
  };

  const up = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const position = new THREE.Vector3();
  const side = new THREE.Vector3();
  const correctedUp = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const basisMatrix = new THREE.Matrix4();
  const advanceRoundaboutCooldown = (car: TrafficCar, distance: number) => {
    if (
      car.roundaboutState?.phase !== "cooldown" ||
      car.edge.to.junctionId === car.roundaboutState.junctionId
    )
      return;
    car.roundaboutState.cooldownDistance += distance;
    if (car.roundaboutState.cooldownDistance >= TRAFFIC_ROUNDABOUT_COOLDOWN_DISTANCE) {
      car.roundaboutState = null;
    }
  };

  const advance = (car: TrafficCar, travel: number) => {
    if (car.stalled) return;
    let remaining = travel;
    let transitions = 0;
    while (remaining > 0 && transitions++ < 128) {
      const edgeRemaining = car.edge.length - car.edgeDistance;
      if (remaining <= edgeRemaining) {
        car.edgeDistance += remaining;
        advanceRoundaboutCooldown(car, remaining);
        return;
      }
      remaining -= edgeRemaining;
      advanceRoundaboutCooldown(car, edgeRemaining);
      const next = chooseNextTrafficEdge(
        car.edge,
        car.recentEdgeIds,
        car.recentSpatialKeys,
        Math.random,
        car.recentJunctionIds,
        onTrafficDecision
          ? (event) =>
              onTrafficDecision({
                ...event,
                carIndex: car.debugIndex,
                modelUrl: car.modelUrl,
                position: car.group.position.toArray(),
              })
          : undefined,
        car.roundaboutState,
      );
      if (!next) {
        if (!recoverCarRoute(car)) return;
        continue;
      }
      const previous = car.edge;
      car.edge = next;
      car.edgeDistance = 0;
      car.roundaboutState = updateRoundaboutState(car.roundaboutState, previous, next);
      car.recentEdgeIds.push(next.id);
      car.recentSpatialKeys.push(trafficSpatialKey(next.to));
      if (next.to.junctionId != null && next.to.junctionId !== next.from.junctionId) {
        car.recentJunctionIds.push(next.to.junctionId);
      }
      if (car.recentEdgeIds.length > 1024) car.recentEdgeIds.shift();
      if (car.recentSpatialKeys.length > 1024) car.recentSpatialKeys.shift();
      if (car.recentJunctionIds.length > 64) car.recentJunctionIds.shift();
    }
  };

  const update = (dt: number, playerPosition?: THREE.Vector3) => {
    const step = Math.max(0, Math.min(dt, 0.05));
    const followerSamples: TrafficFollowerSample[] = cars_.map((car) => ({
      position: car.group.position,
      tangent: car.edge.tangent,
      halfLength: Math.max(car.halfExtents.x, car.halfExtents.z),
    }));
    for (const car of cars_) {
      advance(
        car,
        limitTrafficAdvance(
          car.speed * step,
          car.group.position,
          car.edge.tangent,
          Math.max(car.halfExtents.x, car.halfExtents.z),
          followerSamples,
        ),
      );
      const edgeT = Math.min(1, Math.max(0, car.edgeDistance / car.edge.length));
      position.lerpVectors(car.edge.from.position, car.edge.to.position, edgeT);
      up.lerpVectors(car.edge.from.normal, car.edge.to.normal, edgeT).normalize();
      if (up.y < 0) up.negate();
      position.y += car.groundOffset + 0.03;
      const moved = position.distanceToSquared(car.group.position) >= 1e-8;
      if (moved)
        resolveTrafficMovementTangent(car.group.position, position, car.edge.tangent, tangent);
      else tangent.copy(car.edge.tangent);
      const dx = position.x - camera.position.x;
      const dz = position.z - camera.position.z;
      car.group.visible = dx * dx + dz * dz <= TRAFFIC_CULL_DISTANCE_SQ;
      if (step === 0 || moved) {
        side.crossVectors(tangent, up);
        if (side.lengthSq() < 1e-8) side.set(0, 0, 1);
        side.normalize();
        correctedUp.crossVectors(side, tangent).normalize();
        basisMatrix.makeBasis(tangent, correctedUp, side);
        targetQuat.setFromRotationMatrix(basisMatrix);
        // Use the actual movement tangent, but turn over a few frames at
        // dense roundabout samples instead of spinning at a waypoint.
        car.group.quaternion.slerp(targetQuat, step === 0 ? 1 : Math.min(1, step * 12));
      }
      car.group.position.copy(position);
    }

    if (!physicsWorld || !playerPosition) {
      if (activeColliderIndices.size > 0)
        reconcileActiveIndices(
          activeColliderIndices,
          new Set(),
          activateCollider,
          deactivateCollider,
        );
      return;
    }
    const desired = selectActiveColliderIndices(
      cars_.map((car) => car.group.position),
      playerPosition,
      collisionRadius,
      maxActiveColliders,
    );
    reconcileActiveIndices(activeColliderIndices, desired, activateCollider, deactivateCollider);
    for (const index of activeColliderIndices) {
      const car = cars_[index];
      if (!car.body) continue;
      car.body.setNextKinematicTranslation(car.group.position);
      const q = car.group.quaternion;
      car.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  };

  update(0);
  return {
    group,
    update,
    stats: {
      nodes: graphs.reduce((sum, graph) => sum + graph.nodes.length, 0),
      edges: graphs.reduce((sum, graph) => sum + graph.edges.length, 0),
      totalLength: totalRouteLength,
      cars: count,
      maxWaypointGap: Math.max(...graphs.map((graph) => graph.maxEdgeLength)),
    },
    attachPhysics,
    dispose: () => {
      if (physicsWorld)
        reconcileActiveIndices(
          activeColliderIndices,
          new Set(),
          activateCollider,
          deactivateCollider,
        );
      physicsWorld = null;
      group.removeFromParent();
      disposeUniqueMeshResources([group, ...loadedModels.map((model) => model.scene)]);
      group.clear();
    },
  };
}
