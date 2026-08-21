import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import * as THREE from "three";
import {
  buildClosedRoute,
  buildAuthoredTrafficGraph,
  applyTrafficRoundaboutZones,
  chooseNextTrafficEdge,
  disposeUniqueMeshResources,
  limitTrafficAdvance,
  reconcileActiveIndices,
  resolveTrafficProfile,
  resolveTrafficModelYawOffset,
  sampleClosedRoute,
  resolveTrafficMovementTangent,
  selectActiveColliderIndices,
  trafficTurnDot,
  trafficSpatialKey,
  type TrackPoint,
  type TrafficFollowerSample,
} from "../src/traffic";

const position = new THREE.Vector3();
const tangent = new THREE.Vector3();
const normal = new THREE.Vector3();
const oneSecondTrafficDistance = 26 / 3.6;

function findRepeatingTrafficCycle(
  graph: ReturnType<typeof buildAuthoredTrafficGraph>,
  edgeIds: readonly number[],
): { period: number; distance: number } | null {
  for (let period = 1; period <= 64 && period * 2 <= edgeIds.length; period++) {
    let repeats = true;
    for (let offset = 0; offset < period; offset++) {
      const latest = edgeIds.length - 1 - offset;
      if (
        edgeIds[latest] !== edgeIds[latest - period] ||
        edgeIds[latest - period] !== edgeIds[latest - period * 2]
      ) {
        repeats = false;
        break;
      }
    }
    if (!repeats) continue;
    const distance = edgeIds
      .slice(-period)
      .reduce((sum, edgeId) => sum + graph.edges[edgeId].length, 0);
    if (distance <= oneSecondTrafficDistance) return { period, distance };
  }
  return null;
}

describe("closed traffic route sampling", () => {
  const square: TrackPoint[] = [
    [0, 0, 0, 0, 1, 0],
    [10, 0, 0, 0, 1, 0],
    [10, 0, 10, 0, 1, 0],
    [0, 0, 10, 0, 1, 0],
  ];

  test("includes every segment, including last waypoint back to first", () => {
    const route = buildClosedRoute(square);
    expect(route.segmentLengths).toEqual([10, 10, 10, 10]);
    expect(route.cumulativeLengths).toEqual([0, 10, 20, 30, 40]);
    expect(route.totalLength).toBe(40);
  });

  test("crosses the loop boundary without a teleport or skipped point", () => {
    const route = buildClosedRoute(square);
    const before = sampleClosedRoute(route, 39.75, position, tangent, normal);
    const beforePosition = position.clone();
    const after = sampleClosedRoute(route, 40.25, position, tangent, normal);
    expect(before).toBe(3);
    expect(after).toBe(0);
    expect(beforePosition.distanceTo(position)).toBeLessThanOrEqual(0.36);
    expect(position.toArray()).toEqual([0.25, 0, 0]);
  });

  test("takes an authored roundabout exit instead of starting another lap", () => {
    const junction: TrackPoint = [0, 0, 0, 0, 1, 0];
    const circle: TrackPoint[] = Array.from({ length: 10 }, (_, index) => {
      const angle = ((index + 1) / 11) * Math.PI * 2;
      return [1 - Math.cos(angle), 0, Math.sin(angle), 0, 1, 0] as TrackPoint;
    });
    const route = buildClosedRoute([
      [-2, 0, 0, 0, 1, 0],
      junction,
      ...circle,
      junction,
      ...circle,
      junction,
      [2, 0, 0, 0, 1, 0],
      [3, 0, -1, 0, 1, 0],
      [3, 0, -2, 0, 1, 0],
      [2, 0, -3, 0, 1, 0],
      [1, 0, -3, 0, 1, 0],
      [0, 0, -3, 0, 1, 0],
      [-1, 0, -3, 0, 1, 0],
      [-2, 0, -2, 0, 1, 0],
      [-2, 0, -1, 0, 1, 0],
    ]);
    const graph = buildAuthoredTrafficGraph(route);
    const junctionNode = graph.nodes.find(
      (node) => node.position.distanceToSquared(new THREE.Vector3()) < 1e-8,
    )!;
    expect(junctionNode.outgoing.length).toBe(2);
    const exit = junctionNode.outgoing.find((edge) => edge.to.position.x > 1.5)!;
    const circleIncoming = graph.edges.find(
      (edge) => edge.to === junctionNode && edge.from.position.x < 0.2,
    )!;
    const recentCircleNodes = graph.nodes
      .filter((node) => node !== junctionNode && node !== exit.to)
      .map(trafficSpatialKey);
    expect(chooseNextTrafficEdge(circleIncoming, [], recentCircleNodes, () => 0)).toBe(exit);
  });

  test("limits the reported roundabout to one loop before an exit", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    applyTrafficRoundaboutZones(graph, [{ x: -24.59, z: -6.69, radius: 1.8 }]);
    const starts = graph.edges.filter((edge) => edge.to.junctionKind === "roundabout");
    const targetJunctionId = -1;
    expect(starts.length).toBeGreaterThan(0);
    let repeatedArcs = 0;
    let exits = 0;
    let reentries = 0;
    for (const start of starts.slice(0, 24)) {
      let edge = start;
      const recentEdges = [edge.id];
      const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
      const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
        (id): id is number => id != null,
      );
      const seenRoundaboutEdges = new Set<number>([edge.id]);
      const roundaboutState =
        edge.to.junctionKind === "roundabout" && edge.to.junctionId != null
          ? {
              junctionId: edge.to.junctionId,
              phase: "inside" as const,
              seenEdgeIds: seenRoundaboutEdges,
              cooldownDistance: 0,
            }
          : null;
      let wasInsideRoundabout = edge.to.junctionId === targetJunctionId;
      let exitedRoundabout = false;
      for (let step = 0; step < 160; step++) {
        const next = chooseNextTrafficEdge(
          edge,
          recentEdges,
          recentSpaces,
          () => 0.5,
          recentJunctions,
          undefined,
          roundaboutState,
        );
        if (!next) break;
        const entersRoundabout = !wasInsideRoundabout && next.to.junctionId === targetJunctionId;
        if (entersRoundabout && exitedRoundabout) reentries++;
        if (edge.to.junctionId === targetJunctionId && next.to.junctionId !== targetJunctionId) {
          exits++;
          exitedRoundabout = true;
        }
        wasInsideRoundabout = next.to.junctionId === targetJunctionId;
        if (next.to.junctionId === targetJunctionId && seenRoundaboutEdges.has(next.id))
          repeatedArcs++;
        expect(
          trafficTurnDot(edge, next) >= -0.25 ||
            edge.to.junctionKind === "roundabout" ||
            (edge.to.junctionId == null &&
              next.to.outgoing.some((candidate) => trafficTurnDot(next, candidate) >= -0.25)),
        ).toBe(true);
        if (next.to.junctionId === targetJunctionId) seenRoundaboutEdges.add(next.id);
        edge = next;
        recentEdges.push(edge.id);
        recentSpaces.push(trafficSpatialKey(edge.to));
        if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
          recentJunctions.push(edge.to.junctionId);
        if (recentJunctions.length > 64) recentJunctions.shift();
      }
    }
    expect(repeatedArcs).toBe(0);
    expect(exits).toBeGreaterThan(0);
    expect(reentries).toBe(0);
  });

  test("does not re-enter the plaza roundabout after taking its exit", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    applyTrafficRoundaboutZones(graph, [{ x: -24.59, z: -6.69, radius: 1.8 }]);
    let edge = graph.edges.find(
      (candidate) => candidate.to.junctionId === -1 && candidate.from.junctionKind !== "roundabout",
    )!;
    const recentEdges = [edge.id];
    const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
    const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
      (id): id is number => id != null,
    );
    let entries = edge.to.junctionId === -1 && edge.from.junctionId !== -1 ? 1 : 0;
    let exits = 0;
    let inside = edge.to.junctionId === -1;
    const roundaboutState = {
      junctionId: edge.to.junctionId!,
      phase: "inside" as const,
      seenEdgeIds: new Set<number>([edge.id]),
      cooldownDistance: 0,
    };
    for (let step = 0; step < 160; step++) {
      const next = chooseNextTrafficEdge(
        edge,
        recentEdges,
        recentSpaces,
        () => 0.5,
        recentJunctions,
        undefined,
        roundaboutState,
      );
      if (!next) break;
      if (!inside && next.to.junctionId === -1) entries++;
      if (inside && next.to.junctionId !== -1) exits++;
      expect(
        trafficTurnDot(edge, next) >= -0.25 ||
          edge.to.junctionKind === "roundabout" ||
          (edge.to.junctionId == null &&
            next.to.outgoing.some((candidate) => trafficTurnDot(next, candidate) >= -0.25)),
      ).toBe(true);
      if (next.to.junctionId === -1) roundaboutState.seenEdgeIds.add(next.id);
      inside = next.to.junctionId === -1;
      edge = next;
      recentEdges.push(edge.id);
      recentSpaces.push(trafficSpatialKey(edge.to));
      if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
        recentJunctions.push(edge.to.junctionId);
      if (recentEdges.length > 64) recentEdges.shift();
      if (recentSpaces.length > 64) recentSpaces.shift();
      if (recentJunctions.length > 64) recentJunctions.shift();
    }
    expect(entries).toBe(1);
    expect(exits).toBe(1);
    expect(inside).toBe(false);
  });

  test("persistent roundabout state blocks a later spawn/re-entry loop", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    applyTrafficRoundaboutZones(graph, [{ x: -24.59, z: -6.69, radius: 1.8 }]);
    const entry = graph.edges.find(
      (candidate) => candidate.to.junctionId === -1 && candidate.from.junctionKind !== "roundabout",
    )!;
    const junctionId = entry.to.junctionId!;
    const state = {
      junctionId,
      phase: "inside" as const,
      seenEdgeIds: new Set<number>([entry.id]),
      cooldownDistance: 0,
    };
    const recentEdges = [entry.id];
    const recentSpaces = [trafficSpatialKey(entry.from), trafficSpatialKey(entry.to)];
    let edge = entry;
    let exited = false;
    for (let step = 0; step < 160; step++) {
      const next = chooseNextTrafficEdge(
        edge,
        recentEdges,
        recentSpaces,
        () => 0.5,
        [],
        undefined,
        state,
      );
      if (!next) break;
      if (next.to.junctionKind !== "roundabout") {
        exited = true;
        break;
      }
      state.seenEdgeIds.add(next.id);
      edge = next;
      recentEdges.push(edge.id);
      recentSpaces.push(trafficSpatialKey(edge.to));
    }
    expect(exited).toBe(true);

    const outsideEntry = graph.edges.find(
      (candidate) =>
        candidate.to.junctionKind !== "roundabout" &&
        candidate.to.outgoing.some((next) => next.to.junctionId === junctionId),
    )!;
    const cooldown = {
      junctionId,
      phase: "cooldown" as const,
      seenEdgeIds: state.seenEdgeIds,
      cooldownDistance: 0,
    };
    expect(
      chooseNextTrafficEdge(
        outsideEntry,
        [outsideEntry.id],
        [trafficSpatialKey(outsideEntry.to)],
        () => 0.5,
        [],
        undefined,
        cooldown,
      ),
    ).toBeNull();
  });

  test("applies the re-entry cooldown to automatically detected roundabouts", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const junctionIds = [
      ...new Set(
        graph.nodes
          .filter((node) => node.junctionKind === "roundabout" && node.junctionId != null)
          .map((node) => node.junctionId as number),
      ),
    ];
    expect(junctionIds.length).toBeGreaterThan(0);

    for (const junctionId of junctionIds) {
      const outsideEntry = graph.edges.find(
        (candidate) =>
          candidate.to.junctionKind !== "roundabout" &&
          candidate.to.outgoing.some((next) => next.to.junctionId === junctionId),
      );
      expect(outsideEntry).toBeDefined();
      if (!outsideEntry) continue;
      const cooldown = {
        junctionId,
        phase: "cooldown" as const,
        seenEdgeIds: new Set<number>(),
        cooldownDistance: 0,
      };
      const next = chooseNextTrafficEdge(
        outsideEntry,
        [outsideEntry.id],
        [trafficSpatialKey(outsideEntry.to)],
        () => 0.5,
        [junctionId],
        undefined,
        cooldown,
      );
      expect(next?.to.junctionId).not.toBe(junctionId);

      const afterCooldown = chooseNextTrafficEdge(
        outsideEntry,
        [outsideEntry.id],
        [trafficSpatialKey(outsideEntry.to)],
        () => 0.5,
        [junctionId],
      );
      expect(afterCooldown?.to.junctionId).not.toBe(junctionId);
    }
  });

  test("Isla's authoritative lane has normals and bounded waypoint gaps", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const points = track.lanes.find((lane) => lane.side === "right")?.points ?? [];
    expect(points.length).toBeGreaterThan(1000);
    expect(points.every((point) => point.length === 6)).toBe(true);
    const route = buildClosedRoute(points);
    expect(route.maxWaypointGap).toBeLessThan(0.5);
    const graph = buildAuthoredTrafficGraph(route);
    expect(graph.maxEdgeLength).toBeLessThan(0.5);
    const reportedIntersection = new THREE.Vector3(-0.3, 2.83, 21.72);
    const intersectionZone = graph.nodes.find(
      (node) => node.junctionId != null && node.position.distanceTo(reportedIntersection) < 3,
    )?.junctionId;
    expect(intersectionZone).not.toBeNull();

    let previous = new THREE.Vector3();
    sampleClosedRoute(route, route.totalLength - 0.05, previous, tangent, normal);
    for (let distance = 0; distance <= 0.5; distance += 0.05) {
      sampleClosedRoute(route, distance, position, tangent, normal);
      expect(previous.distanceTo(position)).toBeLessThan(0.11);
      expect(normal.y).toBeGreaterThan(0.5);
      previous = position.clone();
    }

    let maxRoundaboutRun = 0;
    let maxIntersectionRuns = 0;
    let blockedRuns = 0;
    for (let run = 0; run < 5; run++) {
      let edge = graph.edges[(run * 997) % graph.edges.length];
      const recentEdges = [edge.id];
      const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
      const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
        (id): id is number => id != null,
      );
      let roundaboutRun = 0;
      let intersectionRuns = 0;
      let wasInIntersection = false;
      for (let step = 0; step < 3000; step++) {
        const inRoundabout =
          edge.to.position.x > -20 &&
          edge.to.position.x < -5 &&
          edge.to.position.z > 40 &&
          edge.to.position.z < 56;
        roundaboutRun = inRoundabout ? roundaboutRun + 1 : 0;
        maxRoundaboutRun = Math.max(maxRoundaboutRun, roundaboutRun);
        const inReportedIntersection = edge.to.junctionId === intersectionZone;
        if (inReportedIntersection && !wasInIntersection) intersectionRuns++;
        wasInIntersection = inReportedIntersection;
        const next = chooseNextTrafficEdge(
          edge,
          recentEdges,
          recentSpaces,
          () => ((step * 1664525 + run * 1013904223) >>> 0) / 4294967296,
          recentJunctions,
        );
        if (!next) {
          blockedRuns++;
          break;
        }
        edge = next;
        recentEdges.push(edge.id);
        recentSpaces.push(trafficSpatialKey(edge.to));
        if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
          recentJunctions.push(edge.to.junctionId);
        if (recentEdges.length > 1024) recentEdges.shift();
        if (recentSpaces.length > 1024) recentSpaces.shift();
        if (recentJunctions.length > 64) recentJunctions.shift();
      }
      maxIntersectionRuns = Math.max(maxIntersectionRuns, intersectionRuns);
    }
    expect(blockedRuns).toBeLessThanOrEqual(5);
    expect(maxRoundaboutRun).toBeLessThan(200);
    expect(maxIntersectionRuns).toBeLessThanOrEqual(2);
  });

  test("does not repeat a short edge cycle at the reported intersection", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const route = buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []);
    const graph = buildAuthoredTrafficGraph(route);
    const reportedIntersection = new THREE.Vector3(-0.3, 2.83, 21.72);
    let edge = graph.edges.toSorted(
      (a, b) =>
        a.to.position.distanceTo(reportedIntersection) -
        b.to.position.distanceTo(reportedIntersection),
    )[0];
    const recentEdges = [edge.id];
    const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
    const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
      (id): id is number => id != null,
    );
    let shortCycleCount = 0;
    for (let step = 0; step < 256; step++) {
      const next = chooseNextTrafficEdge(edge, recentEdges, recentSpaces, () => 0, recentJunctions);
      expect(next).not.toBeNull();
      if (!next) break;
      if (recentEdges.slice(-16).includes(next.id)) shortCycleCount++;
      edge = next;
      recentEdges.push(edge.id);
      recentSpaces.push(trafficSpatialKey(edge.to));
      if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
        recentJunctions.push(edge.to.junctionId);
      if (recentEdges.length > 1024) recentEdges.shift();
      if (recentSpaces.length > 1024) recentSpaces.shift();
      if (recentJunctions.length > 64) recentJunctions.shift();
    }
    expect(shortCycleCount).toBe(0);
  });

  test("uses a nearby authored exit when an intersection sample has only a sharp continuation", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    // This is the next authored occurrence of the physical road junction
    // around the reported (-31.61, 8.51, 42.34) location. Its exact outgoing
    // edge turns back, while another authored exit starts only a few inches
    // away at the same junction.
    const sharpOnlySample = new THREE.Vector3(-30.9752858, 8.2832668, 42.9520052);
    const incoming = graph.edges.find(
      (edge) => edge.to.position.distanceTo(sharpOnlySample) < 0.01,
    )!;
    const next = chooseNextTrafficEdge(
      incoming,
      [incoming.id],
      [trafficSpatialKey(incoming.from), trafficSpatialKey(incoming.to)],
      () => 0,
    );
    expect(next).not.toBeNull();
    expect(next && trafficTurnDot(incoming, next)).toBeGreaterThanOrEqual(-0.25);
    expect(next?.to.junctionId).not.toBe(incoming.to.junctionId);
    expect(next?.from.position.distanceTo(incoming.to.position)).toBeLessThanOrEqual(2.5);
  });

  test("keeps fountain-roundabout telemetry from selecting micro U-turns", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const fountain = new THREE.Vector3(-38.064, 0, 23.363);
    const decisions: Array<{
      turnDot: number | null;
      nextEdgeId: number | null;
      rejectedUTurns: Array<unknown>;
    }> = [];

    for (const edge of graph.edges) {
      if (
        edge.to.junctionId == null ||
        Math.hypot(edge.to.position.x - fountain.x, edge.to.position.z - fountain.z) > 8
      )
        continue;
      chooseNextTrafficEdge(
        edge,
        [edge.id],
        [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)],
        () => 0.5,
        [],
        (event) => decisions.push(event),
      );
    }

    const selectedUTurns = decisions.filter(
      (event) => event.nextEdgeId != null && (event.turnDot ?? 1) < -0.25,
    );
    expect(decisions.length).toBeGreaterThan(0);
    expect(selectedUTurns).toEqual([]);
  });

  test("keeps the fountain's same-bucket forward branch instead of reversing", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const fountainEdge = graph.edges.find(
      (edge) => Math.hypot(edge.to.position.x + 36.7, edge.to.position.z - 27.783) < 0.02,
    );
    expect(fountainEdge).toBeDefined();
    if (!fountainEdge) return;

    const next = chooseNextTrafficEdge(
      fountainEdge,
      [fountainEdge.id],
      [trafficSpatialKey(fountainEdge.from), trafficSpatialKey(fountainEdge.to)],
      () => 0.5,
    );
    expect(next).not.toBeNull();
    expect(next && trafficTurnDot(fountainEdge, next)).toBeGreaterThanOrEqual(-0.25);
  });

  test("does not enter the reported intersection branch loop", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const incoming = graph.edges.find((edge) => edge.id === 10074)!;
    const next = chooseNextTrafficEdge(
      incoming,
      [incoming.id],
      [trafficSpatialKey(incoming.from), trafficSpatialKey(incoming.to)],
      () => 0.5,
    );
    expect(next?.id).toBe(10075);
    const continuation = graph.edges.find((edge) => edge.id === 10118)!;
    expect(next?.id).not.toBe(continuation.id);
  });

  test("records and rejects backward branch choices without a continuous authored bend", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const selectedReverseTurns: Array<{
      reason: string;
      junctionId: number | null;
      edgeId: number;
      nextEdgeId: number;
      turnDot: number;
    }> = [];
    const rejectedTurns: Array<{ edgeId: number; nextEdgeId: number; turnDot: number }> = [];
    let observedDecisions = 0;
    let blockedPaths = 0;

    for (let run = 0; run < 20; run++) {
      let edge = graph.edges[(run * 997) % graph.edges.length];
      const recentEdges = [edge.id];
      const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
      const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
        (id): id is number => id != null,
      );
      for (let step = 0; step < 150; step++) {
        const next = chooseNextTrafficEdge(
          edge,
          recentEdges,
          recentSpaces,
          () => ((step * 1664525 + run * 1013904223) >>> 0) / 4294967296,
          recentJunctions,
          (event) => {
            observedDecisions++;
            for (const rejected of event.rejectedUTurns) {
              rejectedTurns.push({
                edgeId: event.edgeId,
                nextEdgeId: rejected.edgeId,
                turnDot: rejected.turnDot,
              });
            }
            if (event.nextEdgeId != null && event.turnDot != null && event.turnDot < -0.25) {
              selectedReverseTurns.push({
                reason: event.reason,
                junctionId: event.junctionId,
                edgeId: event.edgeId,
                nextEdgeId: event.nextEdgeId,
                turnDot: event.turnDot,
              });
            }
          },
        );
        if (!next) {
          blockedPaths++;
          break;
        }
        edge = next;
        recentEdges.push(edge.id);
        recentSpaces.push(trafficSpatialKey(edge.to));
        if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
          recentJunctions.push(edge.to.junctionId);
        if (recentEdges.length > 1024) recentEdges.shift();
        if (recentSpaces.length > 1024) recentSpaces.shift();
        if (recentJunctions.length > 64) recentJunctions.shift();
      }
    }

    expect(observedDecisions).toBeGreaterThan(0);
    expect(rejectedTurns.length).toBeGreaterThan(0);
    expect(blockedPaths).toBeLessThan(20);
    expect(
      selectedReverseTurns.every(({ junctionId, edgeId, nextEdgeId }) => {
        if (junctionId != null) return false;
        const source = graph.edges[edgeId];
        const next = graph.edges[nextEdgeId];
        return (
          source.to.junctionId == null &&
          next.to.outgoing.some((candidate) => trafficTurnDot(next, candidate) >= -0.25)
        );
      }),
    ).toBe(true);
  });

  test("never selects a backward branch at a non-dead-end intersection", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const violations: Array<{
      edgeId: number;
      nextEdgeId: number;
      reason: string;
      position: number[];
    }> = [];

    for (const edge of graph.edges) {
      chooseNextTrafficEdge(
        edge,
        [edge.id],
        [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)],
        () => 0.5,
        [],
        (event) => {
          if (event.nextEdgeId == null || event.turnDot == null || event.turnDot >= -0.25) return;
          const source = graph.edges[event.edgeId];
          const hasAuthoredForward = source.to.outgoing.some(
            (candidate) => trafficTurnDot(source, candidate) >= -0.25,
          );
          if (
            (event.reason !== "roundabout" && event.reason !== "dead-end") ||
            (event.reason === "roundabout" && source.to.junctionKind !== "roundabout") ||
            (event.reason === "dead-end" && (hasAuthoredForward || source.to.junctionId != null))
          ) {
            violations.push({
              edgeId: event.edgeId,
              nextEdgeId: event.nextEdgeId,
              reason: event.reason,
              position: source.to.position.toArray(),
            });
          }
        },
      );
    }

    expect(violations).toEqual([]);
  }, 15_000);

  test("faces the actual movement direction instead of a lagging route tangent", () => {
    const target = new THREE.Vector3();
    const fallback = new THREE.Vector3(1, 0, 0);
    expect(
      resolveTrafficMovementTangent(
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, 1),
        fallback,
        target,
      ).toArray(),
    ).toEqual([0, 0, 1]);
    expect(
      resolveTrafficMovementTangent(
        new THREE.Vector3(2, 3, 4),
        new THREE.Vector3(2, 3, 4),
        fallback,
        target,
      ).toArray(),
    ).toEqual([1, 0, 0]);
  });

  test("maps authored model forward axes onto the runtime +X basis", () => {
    expect(resolveTrafficModelYawOffset("+X")).toBe(0);
    expect(resolveTrafficModelYawOffset("-X")).toBe(Math.PI);
    expect(resolveTrafficModelYawOffset("+Z")).toBe(Math.PI / 2);
    expect(resolveTrafficModelYawOffset("-Z")).toBe(-Math.PI / 2);
  });

  test("has no one-second traffic cycle from any authored edge", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const route = buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []);
    const graph = buildAuthoredTrafficGraph(route);
    const offenders: Array<{
      seed: number;
      start: number;
      step: number;
      period: number;
      position: number[];
    }> = [];
    let deadEnds = 0;

    for (const seed of [0, 1, 2, 3]) {
      const starts = graph.edges;
      for (const start of starts) {
        let state = (Math.imul(start.id + 1, 2654435761) ^ Math.imul(seed + 1, 1013904223)) >>> 0;
        const random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        let edge = start;
        const recentEdges = [edge.id];
        const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
        const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
          (id): id is number => id != null,
        );

        for (let step = 0; step < 48; step++) {
          const next = chooseNextTrafficEdge(
            edge,
            recentEdges,
            recentSpaces,
            random,
            recentJunctions,
          );
          if (!next) {
            deadEnds++;
            break;
          }
          edge = next;
          recentEdges.push(edge.id);
          recentSpaces.push(trafficSpatialKey(edge.to));
          if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
            recentJunctions.push(edge.to.junctionId);
          if (recentEdges.length > 1024) recentEdges.shift();
          if (recentSpaces.length > 1024) recentSpaces.shift();
          if (recentJunctions.length > 64) recentJunctions.shift();
          const cycle = findRepeatingTrafficCycle(graph, recentEdges);
          if (cycle) {
            offenders.push({
              seed,
              start: start.id,
              step: step + 1,
              period: cycle.period,
              position: edge.to.position.toArray(),
            });
            break;
          }
        }
      }
    }

    // A small number of authored cul-de-sac cycles are intentionally handed
    // back to the runtime recovery path; none may become a repeating route.
    expect(deadEnds).toBeLessThan((graph.edges.length * 4) / 10);
    expect(offenders).toEqual([]);
  }, 120_000);

  test("keeps randomized cars advancing through the full graph across seeds", () => {
    const trackUrl = new URL("../../../scenes/isla-azul/assets/track.json", import.meta.url);
    const track = JSON.parse(fs.readFileSync(trackUrl, "utf8")) as {
      lanes: Array<{ side: string; points: TrackPoint[] }>;
    };
    const graph = buildAuthoredTrafficGraph(
      buildClosedRoute(track.lanes.find((lane) => lane.side === "right")?.points ?? []),
    );
    const offenders: Array<{
      batch: number;
      car: number;
      step: number;
      period: number;
      loopDistance: number;
      position: number[];
    }> = [];
    let deadEnds = 0;

    for (const batch of [0, 1, 2, 3, 4, 5, 6, 7]) {
      let globalState = (0x9e3779b9 ^ batch) >>> 0;
      const globalRandom = () => {
        globalState = (Math.imul(globalState, 1664525) + 1013904223) >>> 0;
        return globalState / 4294967296;
      };
      for (let car = 0; car < 50; car++) {
        let state = (globalRandom() * 0xffffffff) >>> 0;
        const random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        let edge = graph.edges[Math.floor(random() * graph.edges.length)];
        const recentEdges = [edge.id];
        const recentSpaces = [trafficSpatialKey(edge.from), trafficSpatialKey(edge.to)];
        const recentJunctions = [edge.from.junctionId, edge.to.junctionId].filter(
          (id): id is number => id != null,
        );

        for (let step = 0; step < 500; step++) {
          const next = chooseNextTrafficEdge(
            edge,
            recentEdges,
            recentSpaces,
            random,
            recentJunctions,
          );
          if (!next) {
            deadEnds++;
            break;
          }
          edge = next;
          recentEdges.push(edge.id);
          recentSpaces.push(trafficSpatialKey(edge.to));
          if (edge.to.junctionId != null && edge.to.junctionId !== edge.from.junctionId)
            recentJunctions.push(edge.to.junctionId);
          if (recentEdges.length > 1024) recentEdges.shift();
          if (recentSpaces.length > 1024) recentSpaces.shift();
          if (recentJunctions.length > 64) recentJunctions.shift();
          const cycle = findRepeatingTrafficCycle(graph, recentEdges);
          if (cycle) {
            offenders.push({
              batch,
              car,
              step,
              period: cycle.period,
              loopDistance: cycle.distance,
              position: edge.to.position.toArray(),
            });
            break;
          }
        }
      }
    }

    // Rejecting every spin/U-turn intentionally blocks more authored reverse
    // micro-branches; runtime recovery handles those stops without selecting
    // a backward edge.
    expect(deadEnds).toBeLessThan(300);
    expect(offenders).toEqual([]);
  }, 120_000);
});

describe("traffic collider lifecycle", () => {
  test("keeps 20 cars on capable devices and reduces low-tier traffic physics", () => {
    const config = { trackUrl: "track.json", modelUrls: ["car.glb"], count: 20 };
    expect(resolveTrafficProfile(config, "high")).toEqual({
      tier: "high",
      count: 20,
      collisionRadius: 90,
      maxActiveColliders: 12,
    });
    expect(resolveTrafficProfile(config, "standard")).toEqual({
      tier: "standard",
      count: 20,
      collisionRadius: 90,
      maxActiveColliders: 12,
    });
    expect(resolveTrafficProfile(config, "low")).toEqual({
      tier: "low",
      count: 10,
      collisionRadius: 70,
      maxActiveColliders: 4,
    });
  });

  test("activates only the nearest cars inside the collision radius", () => {
    const positions = [0, 20, 50, 95, 150].map((x) => new THREE.Vector3(x, 0, 0));
    expect([...selectActiveColliderIndices(positions, new THREE.Vector3(), 90, 2)]).toEqual([0, 1]);
  });

  test("deactivates stale colliders and leaves no phantom entries", () => {
    const active = new Set([0, 1]);
    const activated: number[] = [];
    const deactivated: number[] = [];
    reconcileActiveIndices(
      active,
      new Set([1, 2]),
      (index) => activated.push(index),
      (index) => deactivated.push(index),
    );
    expect([...active]).toEqual([1, 2]);
    expect(activated).toEqual([2]);
    expect(deactivated).toEqual([0]);
    reconcileActiveIndices(
      active,
      new Set(),
      (index) => activated.push(index),
      (index) => deactivated.push(index),
    );
    expect(active.size).toBe(0);
    expect(deactivated).toEqual([0, 1, 2]);
  });
});

describe("traffic following distance", () => {
  const tangent = new THREE.Vector3(1, 0, 0);
  const followerPosition = new THREE.Vector3(0, 0, 0);

  test("stops before a same-lane vehicle", () => {
    const leader: TrafficFollowerSample = {
      position: new THREE.Vector3(2, 0, 0),
      tangent,
      halfLength: 0.8,
    };
    expect(limitTrafficAdvance(0.5, followerPosition, tangent, 0.8, [leader])).toBe(0);
  });

  test("allows travel toward a leader once the gap is clear", () => {
    const leader: TrafficFollowerSample = {
      position: new THREE.Vector3(4, 0, 0),
      tangent,
      halfLength: 0.8,
    };
    expect(limitTrafficAdvance(3, followerPosition, tangent, 0.8, [leader])).toBeCloseTo(1.95);
  });

  test("does not stop for an adjacent or opposing vehicle", () => {
    const adjacent: TrafficFollowerSample = {
      position: new THREE.Vector3(2, 0, 2),
      tangent,
      halfLength: 0.8,
    };
    const opposing: TrafficFollowerSample = {
      position: new THREE.Vector3(2, 0, 0),
      tangent: tangent.clone().negate(),
      halfLength: 0.8,
    };
    expect(limitTrafficAdvance(0.5, followerPosition, tangent, 0.8, [adjacent, opposing])).toBe(
      0.5,
    );
  });
});

test("shared traffic resources are disposed exactly once", () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial();
  const texture = new THREE.Texture();
  material.map = texture;
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let textureDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  material.addEventListener("dispose", () => materialDisposals++);
  texture.addEventListener("dispose", () => textureDisposals++);
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  expect(disposeUniqueMeshResources(root)).toEqual({ geometries: 1, materials: 1, textures: 1 });
  expect(geometryDisposals).toBe(1);
  expect(materialDisposals).toBe(1);
  expect(textureDisposals).toBe(1);
});
