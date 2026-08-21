import * as THREE from "three";

export type ParticleEmitter = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  size: THREE.Vector3;
  spread: number;
  distribution?: "box" | "ellipse";
};

export type ParticleBehavior = "spray" | "fall" | "float";

export type ParticleFieldConfig = {
  name: string;
  behavior: ParticleBehavior;
  color: THREE.ColorRepresentation;
  count: number;
  opacity: number;
  size: number;
  emitters: readonly ParticleEmitter[];
  fall?: {
    spawnHeight?: readonly [number, number];
    speed?: readonly [number, number];
    lifetime?: readonly [number, number];
  };
  spray?: { speed?: readonly [number, number]; lifetime?: readonly [number, number] };
};

export type ParticleManagerConfig = {
  fields: readonly ParticleFieldConfig[];
};

export type ParticleConfigFactory = (roots: readonly THREE.Object3D[]) => ParticleManagerConfig;

export type ParticleManager = {
  update: (delta: number) => void;
  dispose: () => void;
};

type ParticleFieldOptions = Omit<ParticleFieldConfig, "emitters">;

const position = new THREE.Vector3();
const localPosition = new THREE.Vector3();

function randomSigned(): number {
  return Math.random() * 2 - 1;
}

function createParticleMaterial(options: ParticleFieldOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fragmentShader: `
      varying float vOpacity;
      uniform vec3 uColor;
      uniform float uOpacity;

      void main() {
        vec2 centered = gl_PointCoord - vec2(0.5);
        float distance = length(centered);
        float softEdge = smoothstep(0.5, 0.08, distance);
        float highlight = smoothstep(0.18, 0.0, distance);
        gl_FragColor = vec4(uColor * (0.72 + highlight * 0.8), softEdge * vOpacity * uOpacity);
      }
    `,
    name: `${options.name} particles`,
    transparent: true,
    uniforms: {
      uColor: { value: new THREE.Color(options.color) },
      uOpacity: { value: options.opacity },
      uPixelRatio: {
        value: typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 1.5),
      },
      uSize: { value: options.size },
    },
    vertexShader: `
      attribute float aOpacity;
      attribute float aSize;
      varying float vOpacity;
      uniform float uPixelRatio;
      uniform float uSize;

      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = clamp(uSize * aSize * uPixelRatio * 300.0 / max(1.0, -viewPosition.z), 1.0, 28.0);
        vOpacity = aOpacity;
      }
    `,
  });
}

class ParticleField {
  readonly group = new THREE.Group();

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly opacities: Float32Array;
  private readonly sizes: Float32Array;
  private readonly life: Float32Array;
  private readonly lifetime: Float32Array;
  private readonly emitterIndex: Uint16Array;
  private readonly velocity: Float32Array;
  private readonly emitters: readonly ParticleEmitter[];
  private readonly options: ParticleFieldOptions;

  constructor(emitters: readonly ParticleEmitter[], options: ParticleFieldOptions) {
    this.emitters = emitters;
    this.options = options;
    this.positions = new Float32Array(options.count * 3);
    this.opacities = new Float32Array(options.count);
    this.sizes = new Float32Array(options.count);
    this.life = new Float32Array(options.count);
    this.lifetime = new Float32Array(options.count);
    this.emitterIndex = new Uint16Array(options.count);
    this.velocity = new Float32Array(options.count * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aOpacity", new THREE.BufferAttribute(this.opacities, 1));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
    this.material = createParticleMaterial(options);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.name = `${options.name} particle field`;
    this.group.name = `${options.name} particles`;
    this.group.add(this.points);
    for (let index = 0; index < options.count; index += 1) {
      this.emitterIndex[index] = index % Math.max(emitters.length, 1);
      this.life[index] = Math.random() * 2;
      this.reset(index, true);
    }
  }

  update(delta: number): void {
    if (this.emitters.length === 0) return;
    const positionAttribute = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const opacityAttribute = this.geometry.getAttribute("aOpacity") as THREE.BufferAttribute;
    for (let index = 0; index < this.options.count; index += 1) {
      this.life[index] -= delta;
      if (this.life[index] <= 0) this.reset(index, false);
      const velocityOffset = index * 3;
      const positionOffset = index * 3;
      if (this.options.behavior === "spray" || this.options.behavior === "fall") {
        this.velocity[velocityOffset + 1] -= delta * 2.4;
      } else {
        this.velocity[velocityOffset] *= Math.max(0, 1 - delta * 0.4);
        this.velocity[velocityOffset + 2] *= Math.max(0, 1 - delta * 0.4);
      }
      this.positions[positionOffset] += this.velocity[velocityOffset] * delta;
      this.positions[positionOffset + 1] += this.velocity[velocityOffset + 1] * delta;
      this.positions[positionOffset + 2] += this.velocity[velocityOffset + 2] * delta;
      const normalizedLife = Math.max(0, this.life[index] / this.lifetime[index]);
      const fade = Math.min(1, normalizedLife * 4, (1 - normalizedLife) * 4);
      this.opacities[index] = fade * (this.options.behavior === "float" ? 0.75 : 0.9);
    }
    positionAttribute.needsUpdate = true;
    opacityAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.group.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }

  private reset(index: number, stagger: boolean): void {
    const emitter = this.emitters[this.emitterIndex[index] % this.emitters.length];
    if (!emitter) return;
    const positionOffset = index * 3;
    const velocityOffset = index * 3;
    if (this.options.behavior === "spray") {
      if (emitter.distribution === "ellipse") {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random());
        localPosition.set(
          Math.cos(angle) * emitter.size.x * 0.5 * radius,
          randomSigned() * emitter.size.y * 0.5,
          Math.sin(angle) * emitter.size.z * 0.5 * radius,
        );
      } else {
        localPosition.set(
          randomSigned() * emitter.size.x * 0.5,
          randomSigned() * emitter.size.y * 0.5,
          randomSigned() * emitter.size.z * 0.5,
        );
      }
      position.copy(localPosition).applyQuaternion(emitter.quaternion).add(emitter.position);
      this.positions[positionOffset] = position.x;
      this.positions[positionOffset + 1] = position.y;
      this.positions[positionOffset + 2] = position.z;
      if (emitter.distribution === "ellipse") {
        const radialLength = Math.hypot(localPosition.x, localPosition.z);
        const radialX = radialLength > 1e-5 ? localPosition.x / radialLength : randomSigned();
        const radialZ = radialLength > 1e-5 ? localPosition.z / radialLength : randomSigned();
        const radialSpeed = 0.08 + Math.random() * 0.32;
        this.velocity[velocityOffset] = radialX * radialSpeed + randomSigned() * 0.12;
        this.velocity[velocityOffset + 2] = radialZ * radialSpeed + randomSigned() * 0.12;
      } else {
        this.velocity[velocityOffset] = randomSigned() * 0.22;
        this.velocity[velocityOffset + 2] = randomSigned() * 0.22;
      }
      this.velocity[velocityOffset + 1] = 0.5 + Math.random() * 1.2;
      const spraySpeed = this.options.spray?.speed ?? [0.5, 1.7];
      const sprayLifetime = this.options.spray?.lifetime ?? [0.55, 1.8];
      this.velocity[velocityOffset + 1] =
        spraySpeed[0] + Math.random() * (spraySpeed[1] - spraySpeed[0]);
      this.lifetime[index] =
        sprayLifetime[0] + Math.random() * (sprayLifetime[1] - sprayLifetime[0]);
      this.sizes[index] = 0.55 + Math.random() * 1.1;
    } else if (this.options.behavior === "fall") {
      const spawnHeight = this.options.fall?.spawnHeight ?? [0.1, 0.5];
      localPosition.set(
        randomSigned() * emitter.size.x * 0.5,
        emitter.size.y * (spawnHeight[0] + Math.random() * (spawnHeight[1] - spawnHeight[0])),
        randomSigned() * emitter.size.z * 0.5,
      );
      position.copy(localPosition).applyQuaternion(emitter.quaternion).add(emitter.position);
      this.positions[positionOffset] = position.x;
      this.positions[positionOffset + 1] = position.y;
      this.positions[positionOffset + 2] = position.z;
      this.velocity[velocityOffset] = randomSigned() * 0.18;
      const fallSpeed = this.options.fall?.speed ?? [7, 11];
      const fallLifetime = this.options.fall?.lifetime ?? [1.5, 2.8];
      this.velocity[velocityOffset + 1] =
        -fallSpeed[0] - Math.random() * (fallSpeed[1] - fallSpeed[0]);
      this.velocity[velocityOffset + 2] = randomSigned() * 0.18;
      this.lifetime[index] = fallLifetime[0] + Math.random() * (fallLifetime[1] - fallLifetime[0]);
      this.sizes[index] = 0.45 + Math.random() * 0.95;
    } else {
      const radius = emitter.spread * (0.35 + Math.random() * 0.65);
      localPosition.set(
        randomSigned() * radius,
        randomSigned() * radius * 0.6,
        randomSigned() * radius,
      );
      position.copy(localPosition).applyQuaternion(emitter.quaternion).add(emitter.position);
      this.positions[positionOffset] = position.x;
      this.positions[positionOffset + 1] = position.y;
      this.positions[positionOffset + 2] = position.z;
      this.velocity[velocityOffset] = randomSigned() * 0.08;
      this.velocity[velocityOffset + 1] = 0.04 + Math.random() * 0.16;
      this.velocity[velocityOffset + 2] = randomSigned() * 0.08;
      this.lifetime[index] = 1.0 + Math.random() * 2.5;
      this.sizes[index] = 0.45 + Math.random() * 1.1;
    }
    this.life[index] = stagger ? Math.random() * this.lifetime[index] : this.lifetime[index];
    this.opacities[index] = 0;
  }
}

export function createParticleManager(
  scene: THREE.Scene,
  config: ParticleManagerConfig,
): ParticleManager {
  const group = new THREE.Group();
  group.name = "Particle Manager";
  const fields = config.fields
    .filter(({ emitters, count }) => emitters.length > 0 && count > 0)
    .map(({ emitters, ...options }) => new ParticleField(emitters, options));
  fields.forEach((field) => group.add(field.group));
  scene.add(group);

  return {
    update: (delta) => fields.forEach((field) => field.update(delta)),
    dispose: () => {
      group.removeFromParent();
      fields.forEach((field) => field.dispose());
    },
  };
}
