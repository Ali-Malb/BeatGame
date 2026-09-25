import * as THREE from 'three';
import { buildChunk, LOW_DETAIL_BUCKETS, type HighwayMaterials, type SerializedChunkPart } from './chunkBuilder';
import { RoadSpline } from './roadSpline';

interface BuildRequest {
  type: 'build';
  index: number;
  seed: number;
  detail: 0 | 1 | 2;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<BuildRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const spline = new RoadSpline(90210);
// The worker only needs geometry.  Constructing HighwayMaterials here would
// generate every canvas-backed road/building texture before the first chunk,
// delaying the render thread for no benefit.  A tiny material proxy satisfies
// buildChunk's assembly API; the authoritative bucket is carried on
// mesh.userData and is what gets serialized below.
const fallbackMaterial = new THREE.MeshBasicMaterial();
const materials = new Proxy({} as HighwayMaterials, {
  get: (_target, key: string) => {
    if (key === 'windows' || key === 'containers') return [fallbackMaterial, fallbackMaterial, fallbackMaterial, fallbackMaterial, fallbackMaterial];
    return fallbackMaterial;
  },
});

function copyFloatAttribute(attribute: THREE.BufferAttribute): ArrayBuffer {
  return new Float32Array(attribute.array as ArrayLike<number>).buffer;
}

function serializeGeometry(mesh: THREE.Mesh, bucket: string): SerializedChunkPart {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const index = geometry.index;
  return {
    bucket,
    position: copyFloatAttribute(position),
    normal: normal ? copyFloatAttribute(normal) : null,
    uv: uv ? copyFloatAttribute(uv) : null,
    // Always widen worker indices so the render thread has one index type.
    index: index ? new Uint32Array(index.array as ArrayLike<number>).buffer : null,
  };
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type !== 'build') return;

  try {
    const result = buildChunk(spline, materials, request.index, request.seed, { detail: request.detail });
    const parts: SerializedChunkPart[] = [];
    const transfer: Transferable[] = [];
    for (const child of result.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const bucket = typeof child.userData.bucket === 'string' ? child.userData.bucket : 'concrete';
      // The low tier only needs the road/structural silhouette. Avoid
      // transferring and reallocating decorative buckets that are hidden by
      // Highway.applyChunkQuality anyway.
      if (request.detail === 0 && !LOW_DETAIL_BUCKETS.has(bucket)) continue;
      const part = serializeGeometry(child, bucket);
      parts.push(part);
      for (const buffer of [part.position, part.normal, part.uv, part.index]) {
        if (buffer) transfer.push(buffer);
      }
    }

    scope.postMessage({ type: 'chunk', index: request.index, parts }, transfer.filter((value): value is Transferable => value !== null));
    for (const geometry of result.geometries) geometry.dispose();
  } catch (error) {
    scope.postMessage({
      type: 'error',
      index: request.index,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
