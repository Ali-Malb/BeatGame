/**
 * Highway — streaming manager for road chunks + global scenery (ground plane,
 * passing elevated train). Keeps chunks alive within [playerS - 160, playerS + 700],
 * retains a small recent cache for backtracking, and disposes cache overflow.
 */

import * as THREE from 'three';
import { RoadSpline } from './roadSpline';
import { buildChunk, CHUNK_LEN, HighwayMaterials, LOW_DETAIL_BUCKETS, materialForChunkBucket, type SerializedChunkPart } from './chunkBuilder';
import { ms } from '../core/utils';

interface Chunk {
  index: number;
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
}

export interface ChunkStreamingStats {
  /** number of chunks built since construction */
  builds: number;
  /** number of previously-built chunks reused from the small LRU cache */
  cacheHits: number;
  /** number of chunks waiting for a future frame */
  pending: number;
  /** number of chunks currently attached to the scene */
  active: number;
  /** number of detached chunks retained for reuse */
  cached: number;
  /** number of cached chunks disposed because the cache limit was reached */
  disposals: number;
  /** duration of the most recent build, in milliseconds (worker round-trip when worker is used) */
  lastBuildMs: number;
  /** longest build observed, in milliseconds */
  maxBuildMs: number;
  /** total time spent in buildChunk, in milliseconds */
  totalBuildMs: number;
  /** where the most recent chunk geometry was produced */
  lastBuildSource: 'main' | 'worker';
}

interface ChunkWorkerResponse {
  type: 'chunk' | 'error';
  index: number;
  parts?: SerializedChunkPart[];
  message?: string;
}

/**
 * Keep only a small recent window of detached chunks. This is deliberately
 * smaller than the active draw window: it makes retries/backtracking cheap
 * without turning the infinite road into an unbounded geometry cache.
 */
const CHUNK_CACHE_LIMIT = 4;
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class Highway {
  readonly spline = new RoadSpline(90210);
  readonly mats = new HighwayMaterials();
  private chunks = new Map<number, Chunk>();
  /** detached, recently-used chunks kept for cheap reactivation */
  private cachedChunks = new Map<number, Chunk>();
  /** chunks requested by the streaming window but not built yet */
  private pendingChunks = new Set<number>();
  private scene: THREE.Scene;
  private rng = Math.random;

  /** lightweight counters used by the browser performance probe */
  readonly streamingStats: ChunkStreamingStats = {
    builds: 0,
    cacheHits: 0,
    pending: 0,
    active: 0,
    cached: 0,
    disposals: 0,
    lastBuildMs: 0,
    maxBuildMs: 0,
    totalBuildMs: 0,
    lastBuildSource: 'worker',
  };

  /** worker state; the main-thread builder remains a compatibility fallback */
  private chunkWorker: Worker | null = null;
  private workerBuildIndex: number | null = null;
  private workerBuildStarted = 0;
  private lastWorkerDispatch = 0;
  private lastPlayerChunk = 0;
  private renderTier: 0 | 1 | 2 = 2;
  /** first low-tier chunks are built synchronously while the worker module
   * warms up, so a click-to-ride never inherits the worker's cold-start stall */
  private bootstrapRemaining = 5;
  private lastMinChunk = 0;
  private lastMaxChunk = 0;

  // global scenery
  private ground: THREE.Mesh;
  private trainGroup: THREE.Group;
  private trainS = 0;
  private trainDir = 1;
  private trainSpeed = 0;
  private trainActive = false;
  private nextTrainAt = 300;
  private trainMat: THREE.MeshStandardMaterial;
  private trainEmissive: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.chunkWorker = this.createChunkWorker();
    // dark city ground far below
    const groundGeo = new THREE.PlaneGeometry(2400, 2400);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshBasicMaterial({ color: 0x07080a })
    );
    this.ground.position.y = 0.0;
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    // elevated train (single consist that shuttles along the right-side viaduct)
    this.trainGroup = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.4, metalness: 0.6 });
    this.trainMat = bodyMat;
    this.trainEmissive = new THREE.MeshBasicMaterial({ color: 0xd8ecff });
    for (let c = 0; c < 3; c++) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.1, 19), bodyMat);
      body.position.z = c * 20.5;
      body.castShadow = false;
      this.trainGroup.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.3, 19.4), bodyMat);
      roof.position.set(0, 1.7, c * 20.5);
      this.trainGroup.add(roof);
      // lit window strips
      for (const side of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(18, 1.2), this.trainEmissive);
        strip.position.set(side * 1.46, 0.3, c * 20.5);
        strip.rotation.y = (side * Math.PI) / 2;
        this.trainGroup.add(strip);
      }
    }
    this.trainGroup.visible = false;
    scene.add(this.trainGroup);
  }

  /** ensure chunks around the player exist; queue at most one build per frame */
  update(playerS: number, dt: number) {
    void dt;
    // Shorter low-tier horizon removes a large number of distant draw calls;
    // the spline, collision surface, and deterministic chunk seeds are unchanged.
    const behindMeters = this.renderTier === 0 ? 50 : 160;
    const aheadMeters = this.renderTier === 0 ? 320 : 700;
    const minChunk = Math.floor((playerS - behindMeters) / CHUNK_LEN);
    const maxChunk = Math.floor((playerS + aheadMeters) / CHUNK_LEN);
    this.lastMinChunk = minChunk;
    this.lastMaxChunk = maxChunk;
    this.lastPlayerChunk = Math.floor(playerS / CHUNK_LEN);

    // A player can move several chunk boundaries during a long frame. Do not
    // leave work queued for chunks that are already outside the draw window.
    for (const idx of this.pendingChunks) {
      if (idx < minChunk || idx > maxChunk) this.pendingChunks.delete(idx);
    }

    // Reuse a recently detached chunk before asking the procedural builder for
    // another one. This is the fast path for retries and short backtracks.
    for (let i = minChunk; i <= maxChunk; i++) {
      if (this.chunks.has(i)) continue;
      const cached = this.cachedChunks.get(i);
      if (cached) {
        this.cachedChunks.delete(i);
        this.scene.add(cached.group);
        this.chunks.set(i, cached);
        this.streamingStats.cacheHits++;
        continue;
      }
      this.pendingChunks.add(i);
    }

    // Detach far chunks into the bounded LRU instead of immediately disposing
    // them. Map insertion order gives us a cheap oldest-entry eviction.
    for (const [idx, chunk] of this.chunks) {
      if (idx < minChunk || idx > maxChunk) {
        this.scene.remove(chunk.group);
        this.chunks.delete(idx);
        this.cachedChunks.delete(idx);
        this.cachedChunks.set(idx, chunk);
        this.trimChunkCache();
      }
    }

    // The worker owns procedural geometry construction whenever available. The
    // fallback below remains bounded to one chunk per frame for older runtimes
    // or worker startup failures.
    this.pumpChunkBuild();

    // ground follows player (keeps infinite feel, no texture so no swim)
    const p = this.frame(playerS);
    this.ground.position.set(p.x, 0, p.z);

    this.updateTrain(playerS, dt);
    this.updateStreamingStats();
  }

  /** Change the visual detail budget without changing spline/world state. */
  setQualityTier(tier: 0 | 1 | 2): void {
    this.renderTier = tier;
    if (tier === 0) this.bootstrapRemaining = 5;
    for (const chunk of this.chunks.values()) this.applyChunkQuality(chunk);
    for (const chunk of this.cachedChunks.values()) this.applyChunkQuality(chunk);
  }

  private applyChunkQuality(chunk: Chunk): void {
    for (const child of chunk.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const bucket = typeof child.userData.bucket === 'string' ? child.userData.bucket : '';
      child.visible = this.renderTier > 0 || LOW_DETAIL_BUCKETS.has(bucket);
    }
  }

  private createChunkWorker(): Worker | null {
    // Bun/Node may expose a Worker shim without a DOM worker URL runtime.
    // Restrict this path to the browser; headless callers use the bounded
    // synchronous fallback and remain deterministic.
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
    try {
      const worker = new Worker(new URL('./chunkBuilder.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', this.onWorkerMessage);
      worker.addEventListener('error', this.onWorkerError);
      return worker;
    } catch {
      // Some embedded/headless runtimes do not support module workers. The
      // bounded main-thread fallback below keeps those environments functional.
      return null;
    }
  }

  private onWorkerMessage = (event: MessageEvent<ChunkWorkerResponse>) => {
    const data = event.data;
    if (!data || (data.type !== 'chunk' && data.type !== 'error')) return;
    if (this.workerBuildIndex !== data.index) return;

    if (data.type === 'error') {
      this.pendingChunks.add(data.index);
      this.workerBuildIndex = null;
      return;
    }

    try {
      const chunk = this.deserializeChunk(data.index, data.parts ?? []);
      const elapsed = nowMs() - this.workerBuildStarted;
      this.workerBuildIndex = null;
      this.recordBuild(data.index, elapsed, 'worker');
      this.activateOrCache(data.index, chunk);
      this.updateStreamingStats();
    } catch {
      // Do not take down the render loop if a worker payload is malformed.
      // Requeue the index so the fallback can retry it on the next update.
      this.pendingChunks.add(data.index);
      this.workerBuildIndex = null;
    }
  };

  private onWorkerError = () => {
    const inFlight = this.workerBuildIndex;
    if (inFlight !== null) this.pendingChunks.add(inFlight);
    this.workerBuildIndex = null;
    this.stopWorker();
  };

  private stopWorker(): void {
    const worker = this.chunkWorker;
    this.chunkWorker = null;
    if (!worker) return;
    worker.removeEventListener('message', this.onWorkerMessage);
    worker.removeEventListener('error', this.onWorkerError);
    worker.terminate();
  }

  private pumpChunkBuild(): void {
    if (this.workerBuildIndex !== null) return;
    const idx = this.nextPendingIndex();
    if (idx === null) return;

    if (this.renderTier === 0 && this.bootstrapRemaining > 0) {
      this.bootstrapRemaining--;
      this.buildMainChunk(idx);
      return;
    }

    if (this.chunkWorker) {
      // Leave a small gap between worker jobs at reduced quality.  A worker
      // compiling/merging a chunk should not continuously compete with a
      // software rasterizer for the same CPU cores.
      const dispatchGap = this.renderTier === 0 ? 800 : this.renderTier === 1 ? 120 : 0;
      const now = nowMs();
      if (dispatchGap > 0 && now - this.lastWorkerDispatch < dispatchGap) return;
      this.pendingChunks.delete(idx);
      this.workerBuildIndex = idx;
      this.workerBuildStarted = now;
      this.lastWorkerDispatch = now;
      try {
        this.chunkWorker.postMessage({ type: 'build', index: idx, seed: (idx * 2654435761) % 2147483647, detail: this.renderTier });
      } catch {
        this.pendingChunks.add(idx);
        this.workerBuildIndex = null;
        this.stopWorker();
      }
      return;
    }

    // Compatibility fallback: still strictly one chunk per frame, never the
    // whole missing range in one update.
    this.buildMainChunk(idx);
  }

  private buildMainChunk(idx: number): void {
    this.pendingChunks.delete(idx);
    const started = nowMs();
    try {
      const { group, geometries } = buildChunk(this.spline, this.mats, idx, (idx * 2654435761) % 2147483647, { detail: this.renderTier });
      const elapsed = nowMs() - started;
      const chunk = { index: idx, group, geometries };
      this.applyChunkQuality(chunk);
      this.recordBuild(idx, elapsed, 'main');
      this.activateOrCache(idx, chunk);
    } catch (error) {
      this.pendingChunks.add(idx);
      throw error;
    }
  }

  private recordBuild(index: number, elapsed: number, source: 'main' | 'worker'): void {
    void index;
    this.streamingStats.builds++;
    this.streamingStats.lastBuildMs = elapsed;
    this.streamingStats.lastBuildSource = source;
    this.streamingStats.maxBuildMs = Math.max(this.streamingStats.maxBuildMs, elapsed);
    this.streamingStats.totalBuildMs += elapsed;
  }

  private activateOrCache(index: number, chunk: Chunk): void {
    if (index >= this.lastMinChunk && index <= this.lastMaxChunk) {
      this.scene.add(chunk.group);
      this.chunks.set(index, chunk);
      return;
    }
    this.cachedChunks.delete(index);
    this.cachedChunks.set(index, chunk);
    this.trimChunkCache();
  }

  private deserializeChunk(index: number, parts: SerializedChunkPart[]): Chunk {
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    for (const part of parts) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(part.position), 3));
      if (part.normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(part.normal), 3));
      if (part.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(part.uv), 2));
      if (part.index) geometry.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(part.index), 1));
      const mesh = new THREE.Mesh(geometry, materialForChunkBucket(this.mats, part.bucket));
      mesh.userData.bucket = part.bucket;
      mesh.castShadow = false;
      mesh.receiveShadow = part.bucket === 'asphalt' || part.bucket === 'asphaltOnc' || part.bucket === 'concrete';
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      geometries.push(geometry);
    }
    const chunk = { index, group, geometries };
    this.applyChunkQuality(chunk);
    return chunk;
  }

  private nextPendingIndex(): number | null {
    let ahead: number | undefined;
    let behind: number | undefined;
    for (const idx of this.pendingChunks) {
      if (idx >= this.lastPlayerChunk) {
        if (ahead === undefined || idx < ahead) ahead = idx;
      } else if (behind === undefined || idx < behind) {
        behind = idx;
      }
    }
    return ahead ?? behind ?? null;
  }

  private trimChunkCache(): void {
    while (this.cachedChunks.size > CHUNK_CACHE_LIMIT) {
      const oldest = this.cachedChunks.keys().next().value;
      if (oldest === undefined) break;
      const chunk = this.cachedChunks.get(oldest);
      this.cachedChunks.delete(oldest);
      if (chunk) this.disposeChunk(chunk);
      this.streamingStats.disposals++;
    }
  }

  private updateStreamingStats(): void {
    this.streamingStats.pending = this.pendingChunks.size;
    this.streamingStats.active = this.chunks.size;
    this.streamingStats.cached = this.cachedChunks.size;
  }

  private disposeChunk(chunk: Chunk): void {
    for (const geometry of chunk.geometries) geometry.dispose();
  }

  private pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
  frame(s: number) {
    this.spline.get(s, this.pt);
    return this.pt;
  }

  private updateTrain(playerS: number, dt: number) {
    if (!this.trainActive) {
      if (playerS + 350 > this.nextTrainAt) {
        this.trainActive = true;
        this.trainDir = this.rng() < 0.5 ? 1 : -1;
        this.trainSpeed = ms(this.trainDir === 1 ? 96 : 88) + this.rng() * 8;
        this.trainS = this.trainDir === 1 ? playerS + 640 : playerS + 700;
        this.nextTrainAt = playerS + 900 + this.rng() * 1400;
        this.trainGroup.visible = true;
      }
      return;
    }
    this.trainS += this.trainSpeed * dt;
    const rel = this.trainS - playerS;
    if (rel < -260 || rel > 780) {
      this.trainActive = false;
      this.trainGroup.visible = false;
      return;
    }
    const p = this.frame(this.trainS);
    const rX = Math.cos(p.yaw);
    const rZ = -Math.sin(p.yaw);
    const lat = 29.5;
    this.trainGroup.position.set(p.x + rX * lat, p.y - 1.6, p.z + rZ * lat);
    this.trainGroup.rotation.y = p.yaw + (this.trainDir === 1 ? 0 : Math.PI);
  }

  /** ambient world animation (beacons, subtle material pulses) */
  tick(time: number) {
    const blink = (Math.sin(time * 3.4) > 0.6 ? 1 : 0.08);
    this.mats.blinkRed.color.setRGB(1 * blink, 0.15 * blink, 0.08 * blink);
    const blinkO = Math.sin(time * 2.6 + 1.2) > 0.5 ? 1 : 0.1;
    this.mats.blinkOrange.color.setRGB(1 * blinkO, 0.55 * blinkO, 0.1 * blinkO);
  }

  dispose() {
    this.stopWorker();
    this.workerBuildIndex = null;
    this.pendingChunks.clear();
    for (const [idx, chunk] of this.chunks) {
      this.scene.remove(chunk.group);
      this.disposeChunk(chunk);
      this.chunks.delete(idx);
    }
    for (const [idx, chunk] of this.cachedChunks) {
      this.disposeChunk(chunk);
      this.cachedChunks.delete(idx);
    }
    this.scene.remove(this.ground);
    (this.ground.geometry as THREE.BufferGeometry).dispose();
    (this.ground.material as THREE.Material).dispose();
    this.scene.remove(this.trainGroup);
    this.trainGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
      }
    });
    this.trainMat.dispose();
    this.trainEmissive.dispose();
    this.spline.dispose();
    this.mats.dispose();
  }
}
