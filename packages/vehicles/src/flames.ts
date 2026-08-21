import * as THREE from "three";

/**
 * Stylized jetpack flame effect that mirrors the Unity Polygon Arsenal flame
 * jets: additive billboard particles streaming down from the pack's bottom
 * nozzles. Idle emits a small steady flame; throttling (ascend) intensifies
 * the jet.
 */

const FLAME_COUNT_PER_NOZZLE = 40;
const FLAME_LIFETIME = 0.45;
const FLAME_GRAVITY = -2.5;

function createFlameSprite(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable for flame texture");
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 30);
  gradient.addColorStop(0, "rgba(255, 255, 230, 1)");
  gradient.addColorStop(0.35, "rgba(255, 190, 90, 0.95)");
  gradient.addColorStop(0.7, "rgba(255, 110, 40, 0.55)");
  gradient.addColorStop(1, "rgba(255, 60, 20, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type FlameParticle = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
};

export type JetpackFlames = {
  readonly group: THREE.Group;
  update: (delta: number, intensity: number) => void;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

export function createJetpackFlames(nozzlePositions: readonly THREE.Vector3[]): JetpackFlames {
  const texture = createFlameSprite();
  const material = new THREE.PointsMaterial({
    map: texture,
    color: 0xffa050,
    size: 0.09,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const positions = new Float32Array(nozzlePositions.length * FLAME_COUNT_PER_NOZZLE * 3);
  const sizes = new Float32Array(nozzlePositions.length * FLAME_COUNT_PER_NOZZLE);
  const colors = new Float32Array(nozzlePositions.length * FLAME_COUNT_PER_NOZZLE * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const particles: FlameParticle[] = [];
  for (let nozzleIndex = 0; nozzleIndex < nozzlePositions.length; nozzleIndex += 1) {
    for (let index = 0; index < FLAME_COUNT_PER_NOZZLE; index += 1) {
      const particle = {
        position: nozzlePositions[nozzleIndex].clone(),
        velocity: new THREE.Vector3(),
        life: Math.random() * FLAME_LIFETIME,
        maxLife: FLAME_LIFETIME * (0.7 + Math.random() * 0.6),
      };
      particles.push(particle);
      const slot = nozzleIndex * FLAME_COUNT_PER_NOZZLE + index;
      positions[slot * 3] = particle.position.x;
      positions[slot * 3 + 1] = particle.position.y;
      positions[slot * 3 + 2] = particle.position.z;
    }
  }

  const color = new THREE.Color();
  const tempPosition = new THREE.Vector3();

  const respawn = (particle: FlameParticle, nozzle: THREE.Vector3, intensity: number) => {
    const spread = 0.03 * (0.5 + intensity);
    particle.position.copy(nozzle);
    particle.position.x += (Math.random() - 0.5) * spread * 2;
    particle.position.z += (Math.random() - 0.5) * spread * 2;
    const speed = (0.9 + Math.random() * 0.5) * (0.4 + intensity);
    particle.velocity.set((Math.random() - 0.5) * 0.15, -speed, (Math.random() - 0.5) * 0.15);
    particle.life = 0;
    particle.maxLife = FLAME_LIFETIME * (0.7 + Math.random() * 0.6);
  };

  const group = new THREE.Group();
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);
  group.visible = true;

  const update = (delta: number, intensity: number) => {
    const clampedIntensity = Math.max(0, Math.min(1, intensity));
    const active = clampedIntensity > 0.02;
    group.visible = active;
    if (!active) return;
    for (let slot = 0; slot < particles.length; slot += 1) {
      const particle = particles[slot];
      const nozzle = nozzlePositions[slot % nozzlePositions.length];
      particle.life += delta;
      if (particle.life >= particle.maxLife) {
        respawn(particle, nozzle, clampedIntensity);
      }
      const lifeRatio = particle.life / particle.maxLife;
      particle.velocity.y += FLAME_GRAVITY * delta;
      tempPosition.copy(particle.velocity).multiplyScalar(delta);
      particle.position.add(tempPosition);
      positions[slot * 3] = particle.position.x;
      positions[slot * 3 + 1] = particle.position.y;
      positions[slot * 3 + 2] = particle.position.z;
      const fade = Math.pow(1 - lifeRatio, 1.6);
      sizes[slot] = (0.05 + 0.11 * fade) * (0.6 + clampedIntensity * 0.8);
      color.setHSL(0.06 - 0.05 * lifeRatio, 1, 0.55 + 0.35 * (1 - lifeRatio));
      colors[slot * 3] = color.r;
      colors[slot * 3 + 1] = color.g;
      colors[slot * 3 + 2] = color.b;
    }
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  };

  return {
    group,
    update,
    setVisible(visible: boolean) {
      group.visible = visible;
    },
    dispose() {
      group.removeFromParent();
      group.remove(points);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

/**
 * Compute flame nozzle anchors from the mounted jetpack's actual exhaust
 * openings. The exhaust pipes are the lowest faces of the pack: collect the
 * vertices sitting on the bottom plane and split them into the two nozzles
 * (left/right) by x position. Falls back to bounding-box fractions when no
 * bottom geometry is found.
 */
export function computeJetpackNozzles(scene: THREE.Object3D): THREE.Vector3[] {
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const bottomY = bounds.min.y;
  const epsilon = Math.max(size.y * 0.02, 1e-4);
  const local = new THREE.Vector3();
  const world = new THREE.Vector3();
  const bottomPoints: Array<{ x: number; z: number }> = [];
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute("position");
    if (!position) return;
    for (let index = 0; index < position.count; index += 1) {
      local.fromBufferAttribute(position, index);
      world.copy(local).applyMatrix4(object.matrixWorld);
      if (world.y <= bottomY + epsilon) {
        bottomPoints.push({ x: world.x, z: world.z });
      }
    }
  });
  if (bottomPoints.length >= 4) {
    const sorted = [...bottomPoints].sort((a, b) => a.x - b.x);
    const mid = Math.floor(sorted.length / 2);
    return [sorted.slice(0, mid), sorted.slice(mid)].map((half) => {
      const centerX = half.reduce((sum, point) => sum + point.x, 0) / half.length;
      const centerZ = half.reduce((sum, point) => sum + point.z, 0) / half.length;
      return new THREE.Vector3(centerX, bottomY + 0.005, centerZ);
    });
  }
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  return [
    new THREE.Vector3(bounds.min.x + size.x * 0.3, bottomY + 0.005, centerZ),
    new THREE.Vector3(bounds.min.x + size.x * 0.62, bottomY + 0.005, centerZ),
  ];
}

/**
 * Stylized hoverboard energy trail: additive cyan-white particles streaming
 * outward along the deck axis from both ends of the board. The board FBX is
 * symmetric and its travel direction is camera-relative, so emitting from both
 * ends keeps the trail behind the board no matter which way it faces.
 */

const TRAIL_COUNT_PER_NOZZLE = 24;
const TRAIL_LIFETIME = 0.55;
const TRAIL_GRAVITY = -1.2;
function createEnergySprite(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable for trail texture");
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 30);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.35, "rgba(190, 235, 255, 0.9)");
  gradient.addColorStop(0.7, "rgba(90, 170, 255, 0.5)");
  gradient.addColorStop(1, "rgba(60, 120, 255, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type TrailParticle = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
};

export type HoverboardTrail = {
  readonly group: THREE.Group;
  update: (delta: number, intensity: number) => void;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

export function createHoverboardTrail(nozzlePositions: readonly THREE.Vector3[]): HoverboardTrail {
  const texture = createEnergySprite();
  const material = new THREE.PointsMaterial({
    map: texture,
    color: 0x9fd8ff,
    size: 0.045,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const positions = new Float32Array(nozzlePositions.length * TRAIL_COUNT_PER_NOZZLE * 3);
  const sizes = new Float32Array(nozzlePositions.length * TRAIL_COUNT_PER_NOZZLE);
  const colors = new Float32Array(nozzlePositions.length * TRAIL_COUNT_PER_NOZZLE * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const particles: TrailParticle[] = [];
  for (let nozzleIndex = 0; nozzleIndex < nozzlePositions.length; nozzleIndex += 1) {
    for (let index = 0; index < TRAIL_COUNT_PER_NOZZLE; index += 1) {
      const particle = {
        position: nozzlePositions[nozzleIndex].clone(),
        velocity: new THREE.Vector3(),
        life: Math.random() * TRAIL_LIFETIME,
        maxLife: TRAIL_LIFETIME * (0.7 + Math.random() * 0.6),
      };
      particles.push(particle);
      const slot = nozzleIndex * TRAIL_COUNT_PER_NOZZLE + index;
      positions[slot * 3] = particle.position.x;
      positions[slot * 3 + 1] = particle.position.y;
      positions[slot * 3 + 2] = particle.position.z;
    }
  }

  const color = new THREE.Color();
  const tempPosition = new THREE.Vector3();

  const respawn = (particle: TrailParticle, nozzle: THREE.Vector3, intensity: number) => {
    particle.position.copy(nozzle);
    particle.position.x += (Math.random() - 0.5) * 0.015;
    particle.position.y += (Math.random() - 0.5) * 0.008;
    const speed = (0.7 + Math.random() * 0.5) * (0.5 + intensity);
    // Emit away from the deck along its local Z axis; the sign flips per end.
    const direction = nozzle.z >= 0 ? 1 : -1;
    particle.velocity.set(
      (Math.random() - 0.5) * 0.12,
      -0.05 - Math.random() * 0.1,
      direction * speed,
    );
    particle.life = 0;
    particle.maxLife = TRAIL_LIFETIME * (0.7 + Math.random() * 0.6);
  };

  const group = new THREE.Group();
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);
  group.visible = true;

  const update = (delta: number, intensity: number) => {
    const clampedIntensity = Math.max(0, Math.min(1, intensity));
    const active = clampedIntensity > 0.02;
    group.visible = active;
    if (!active) return;
    for (let slot = 0; slot < particles.length; slot += 1) {
      const particle = particles[slot];
      const nozzle = nozzlePositions[slot % nozzlePositions.length];
      particle.life += delta;
      if (particle.life >= particle.maxLife) {
        respawn(particle, nozzle, clampedIntensity);
      }
      const lifeRatio = particle.life / particle.maxLife;
      particle.velocity.y += TRAIL_GRAVITY * delta;
      tempPosition.copy(particle.velocity).multiplyScalar(delta);
      particle.position.add(tempPosition);
      positions[slot * 3] = particle.position.x;
      positions[slot * 3 + 1] = particle.position.y;
      positions[slot * 3 + 2] = particle.position.z;
      const fade = Math.pow(1 - lifeRatio, 1.6);
      sizes[slot] = (0.02 + 0.045 * fade) * (0.5 + clampedIntensity * 0.7);
      color.setHSL(0.58 - 0.1 * lifeRatio, 0.85, 0.55 + 0.35 * (1 - lifeRatio));
      colors[slot * 3] = color.r;
      colors[slot * 3 + 1] = color.g;
      colors[slot * 3 + 2] = color.b;
    }
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  };

  return {
    group,
    update,
    setVisible(visible: boolean) {
      group.visible = visible;
    },
    dispose() {
      group.removeFromParent();
      group.remove(points);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

/**
 * Compute energy-trail anchors from the mounted hoverboard's local bounds.
 * The deck is authored flat and symmetric, long axis along Z; anchors sit
 * just inside each end, a little above the deck surface.
 */
export function computeHoverboardTrailAnchors(scene: THREE.Object3D): THREE.Vector3[] {
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const innerX = bounds.min.x + size.x * 0.32;
  const outerX = bounds.min.x + size.x * 0.68;
  const anchorY = bounds.min.y + size.y * 0.3;
  const backZ = bounds.min.z + 0.004;
  const frontZ = bounds.max.z - 0.004;
  return [
    new THREE.Vector3(innerX, anchorY, backZ),
    new THREE.Vector3(outerX, anchorY, backZ),
    new THREE.Vector3(innerX, anchorY, frontZ),
    new THREE.Vector3(outerX, anchorY, frontZ),
  ];
}
