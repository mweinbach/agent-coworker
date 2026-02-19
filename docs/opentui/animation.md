# Animation System

OpenTUI provides two complementary animation systems: a general-purpose **Timeline** engine for property animation on any object, and a **3D sprite animation** subsystem for GPU-instanced sprite sheets, particle effects, and explosion effects.

## Table of Contents

- [Timeline Engine](#timeline-engine)
  - [createTimeline](#createtimeline)
  - [Timeline Class](#timeline-class)
  - [AnimationOptions](#animationoptions)
  - [Easing Functions](#easing-functions)
  - [TimelineEngine](#timelineengine)
- [SpriteAnimator](#spriteanimator)
  - [SpriteDefinition](#spritedefinition)
  - [AnimationDefinition](#animationdefinition)
  - [AnimationStateConfig](#animationstateconfig)
  - [TiledSprite](#tiledsprite)
  - [Animation (internal)](#animation-internal)
- [SpriteParticleGenerator](#spriteparticlegenerator)
  - [ParticleEffectParameters](#particleeffectparameters)
- [ExplodingSpriteEffect](#explodingspriteeffect)
  - [ExplosionEffectParameters](#explosioneffectparameters)
  - [ExplosionManager](#explosionmanager)
  - [ExplosionHandle](#explosionhandle)
- [PhysicsExplodingSpriteEffect](#physicsexplodingspriteeffect)
  - [PhysicsExplosionEffectParameters](#physicsexplosioneffectparameters)
  - [PhysicsExplosionManager](#physicsexplosionmanager)
- [Architecture](#architecture)
- [Related Documentation](#related-documentation)

---

## Timeline Engine

The Timeline engine lives at `@opentui/core` (not the 3D subpath) and provides frame-synchronized property animation for any JavaScript object. It integrates with the `CliRenderer` frame callback system to drive updates automatically.

### Import

```typescript
import { createTimeline, engine, Timeline } from "@opentui/core"
// Types
import type { TimelineOptions, AnimationOptions, EasingFunctions, JSAnimation } from "@opentui/core"
```

### createTimeline

Factory function to create a new `Timeline` and register it with the global engine.

```typescript
function createTimeline(options?: TimelineOptions): Timeline
```

### Timeline Class

```typescript
class Timeline {
  // Public state
  items: (TimelineAnimationItem | TimelineCallbackItem)[]
  subTimelines: TimelineTimelineItem[]
  currentTime: number
  isPlaying: boolean
  isComplete: boolean
  duration: number
  loop: boolean
  synced: boolean

  constructor(options?: TimelineOptions)

  // State change observation
  addStateChangeListener(listener: (timeline: Timeline) => void): void
  removeStateChangeListener(listener: (timeline: Timeline) => void): void

  // Add a property animation to the timeline
  // target: object(s) whose properties will be animated
  // properties: animation config including target values and timing
  // startTime: absolute time or "+N" for relative offset
  add(
    target: any,
    properties: AnimationOptions,
    startTime?: number | string
  ): this

  // Add a one-shot animation (plays once, then stops)
  once(target: any, properties: AnimationOptions): this

  // Schedule a callback at a specific time
  call(callback: () => void, startTime?: number | string): this

  // Synchronize another timeline to play as a child
  sync(timeline: Timeline, startTime?: number): this

  // Playback controls
  play(): this
  pause(): this
  restart(): this
  resetItems(): void

  // Advance the timeline by deltaTime milliseconds
  update(deltaTime: number): void
}
```

### TimelineOptions

```typescript
interface TimelineOptions {
  duration?: number        // Total timeline duration (ms). Auto-calculated if omitted.
  loop?: boolean           // Loop the entire timeline
  autoplay?: boolean       // Start playing immediately on creation
  onComplete?: () => void  // Called when the timeline finishes
  onPause?: () => void     // Called when the timeline is paused
}
```

### AnimationOptions

```typescript
interface AnimationOptions {
  duration: number                      // Animation duration (ms)
  ease?: EasingFunctions                // Easing function name
  onUpdate?: (animation: JSAnimation) => void  // Called each frame
  onComplete?: () => void               // Called when animation completes
  onStart?: () => void                  // Called when animation starts
  onLoop?: () => void                   // Called on each loop iteration
  loop?: boolean | number               // true = infinite, number = loop count
  loopDelay?: number                    // Delay between loop iterations (ms)
  alternate?: boolean                   // Reverse direction on alternate loops
  once?: boolean                        // Play only once
  [key: string]: any                    // Target property values (e.g., x: 100, opacity: 0)
}
```

The `[key: string]: any` index signature allows you to specify target property values directly in the options object. Any key not recognized as an animation option is treated as a property to animate on the target object.

### JSAnimation

```typescript
interface JSAnimation {
  targets: any[]       // The target objects being animated
  deltaTime: number    // Time delta for this frame
  progress: number     // Animation progress (0 to 1)
  currentTime: number  // Elapsed time in the animation
}
```

### Easing Functions

All available easing functions:

| Name | Description |
|------|-------------|
| `linear` | Constant speed |
| `inQuad` | Quadratic ease-in |
| `outQuad` | Quadratic ease-out |
| `inOutQuad` | Quadratic ease-in-out |
| `inExpo` | Exponential ease-in |
| `outExpo` | Exponential ease-out |
| `inOutSine` | Sinusoidal ease-in-out |
| `outBounce` | Bounce effect at end |
| `outElastic` | Elastic overshoot at end |
| `inBounce` | Bounce effect at start |
| `inCirc` | Circular ease-in |
| `outCirc` | Circular ease-out |
| `inOutCirc` | Circular ease-in-out |
| `inBack` | Overshoot at start (configurable `s` parameter) |
| `outBack` | Overshoot at end (configurable `s` parameter) |
| `inOutBack` | Overshoot at both ends (configurable `s` parameter) |

All easing functions have the signature `(t: number) => number`, except `inBack`, `outBack`, and `inOutBack` which accept an optional overshoot parameter `(t: number, s?: number) => number`.

### TimelineEngine

The global singleton engine that drives all registered timelines in sync with the `CliRenderer` frame loop.

```typescript
class TimelineEngine {
  defaults: {
    frameRate: number       // Target frame rate for updates
  }

  // Connect to a CliRenderer to receive frame callbacks
  attach(renderer: CliRenderer): void
  detach(): void

  // Timeline management
  register(timeline: Timeline): void
  unregister(timeline: Timeline): void
  clear(): void

  // Manual update (if not attached to a renderer)
  update(deltaTime: number): void
}

// Global singleton instance
export const engine: TimelineEngine
```

### Timeline Usage Example

```typescript
import { createTimeline, engine } from "@opentui/core"

// Attach to the renderer for automatic frame updates
engine.attach(renderer)

const tl = createTimeline({ loop: true })

const box = { x: 0, y: 0, opacity: 1 }

tl.add(box, {
  duration: 1000,
  ease: "outBounce",
  x: 100,
  y: 50,
})
.add(box, {
  duration: 500,
  ease: "inOutSine",
  opacity: 0,
}, "+200")   // Start 200ms after previous animation ends
.call(() => {
  console.log("Fade complete!")
}, "+0")

tl.play()
```

---

## SpriteAnimator

The `SpriteAnimator` manages GPU-instanced animated sprites in a Three.js scene. Each sprite can have multiple named animation states backed by different sprite sheet regions, and the animator batches all sprites sharing the same texture into a single instanced draw call.

### Import

```typescript
import {
  SpriteAnimator,
  type SpriteDefinition,
  type AnimationDefinition,
  type AnimationStateConfig,
  type ResolvedAnimationState,
} from "@opentui/core/3d"
```

### SpriteAnimator Class

```typescript
class SpriteAnimator {
  constructor(scene: Scene)

  // Create a new animated sprite from a definition
  createSprite(
    userSpriteDefinition: SpriteDefinition,
    materialFactory?: () => NodeMaterial
  ): Promise<TiledSprite>

  // Update all managed sprites (call once per frame)
  update(deltaTime: number): void

  // Remove a sprite by ID
  removeSprite(id: string): void

  // Remove all managed sprites
  removeAllSprites(): void
}
```

### SpriteDefinition

Describes a sprite with one or more named animation states.

```typescript
interface SpriteDefinition {
  id?: string                   // Unique sprite ID (auto-generated if omitted)
  renderOrder?: number          // Render ordering for transparency sorting
  depthWrite?: boolean          // Write to depth buffer
  maxInstances?: number         // Max instance slots for this sprite's animations
  scale?: number                // Base scale multiplier
  initialAnimation: string      // Name of the animation to start in
  animations: Record<string, AnimationDefinition>  // Named animation states
}
```

### AnimationDefinition

Defines a single animation state referencing a `SpriteResource`.

```typescript
interface AnimationDefinition {
  resource: SpriteResource       // The sprite sheet resource
  animNumFrames?: number         // Number of frames in this animation
  animFrameOffset?: number       // Starting frame offset in the sheet
  frameDuration?: number         // Duration per frame (ms)
  loop?: boolean                 // Loop the animation
  initialFrame?: number          // Starting frame index
  flipX?: boolean                // Mirror horizontally
  flipY?: boolean                // Mirror vertically
}
```

### AnimationStateConfig

Raw configuration for an animation state (used before resource resolution).

```typescript
interface AnimationStateConfig {
  imagePath: string
  sheetNumFrames: number
  animNumFrames: number
  animFrameOffset: number
  frameDuration?: number      // Default: engine default
  loop?: boolean              // Default: true
  initialFrame?: number       // Default: 0
  flipX?: boolean             // Default: false
  flipY?: boolean             // Default: false
}
```

### ResolvedAnimationState

The fully resolved animation state with all defaults filled in and texture loaded.

```typescript
type ResolvedAnimationState = Required<AnimationStateConfig> & {
  sheetTilesetWidth: number
  sheetTilesetHeight: number
  texture: THREE.DataTexture
}
```

### TiledSprite

A sprite instance created by `SpriteAnimator`. Provides transform, animation control, and visibility management.

```typescript
class TiledSprite {
  readonly id: string

  // Current animation info
  get currentAnimation(): Animation
  getCurrentAnimationName(): string

  // Transform
  setPosition(position: THREE.Vector3): void
  setRotation(rotation: THREE.Quaternion): void
  setScale(scale: THREE.Vector3): void
  getScale(): THREE.Vector3
  setTransform(
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    scale: THREE.Vector3
  ): void
  getWorldTransform(): THREE.Matrix4
  getWorldPlaneSize(): THREE.Vector2
  get currentTransform(): {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  }

  // Playback
  play(): void
  stop(): void
  goToFrame(frame: number): void
  setFrameDuration(newFrameDuration: number): void
  isPlaying(): boolean

  // Switch to a different named animation
  setAnimation(animationName: string): Promise<void>

  // Update (called by SpriteAnimator.update)
  update(deltaTime: number): void

  // Visibility
  get visible(): boolean
  set visible(value: boolean)

  // Original definition for recreation
  get definition(): SpriteDefinition

  // Cleanup
  destroy(): void
}
```

### Animation (internal)

The internal `Animation` class is not exported but drives each animation state. Each animation tracks its own instance slot in the instanced mesh, frame timing, and GPU buffer attributes.

```typescript
// Not exported, but used internally by TiledSprite
class Animation {
  readonly name: string
  state: ResolvedAnimationState
  instanceIndex: number
  currentLocalFrame: number
  timeAccumulator: number
  isPlaying: boolean

  activate(worldTransform: THREE.Matrix4): void
  deactivate(): void
  updateVisuals(worldTransform: THREE.Matrix4): void
  updateTime(deltaTimeMs: number): boolean
  play(): void
  stop(): void
  goToFrame(localFrame: number): void
  setFrameDuration(newFrameDuration: number): void
  getResource(): SpriteResource
  releaseInstanceSlot(): void
}
```

### SpriteAnimator Example

```typescript
import { SpriteAnimator, SpriteResourceManager } from "@opentui/core/3d"
import * as THREE from "@opentui/core/3d"

const scene = new THREE.Scene()
const resourceManager = new SpriteResourceManager(scene)
const animator = new SpriteAnimator(scene)

// Load sprite sheet resource
const resource = await resourceManager.createResource({
  imagePath: "./assets/character.png",
  sheetNumFrames: 24,
})

// Create animated sprite with two states
const player = await animator.createSprite({
  id: "player",
  scale: 1.0,
  initialAnimation: "idle",
  animations: {
    idle: {
      resource,
      animNumFrames: 4,
      animFrameOffset: 0,
      frameDuration: 200,
      loop: true,
    },
    walk: {
      resource,
      animNumFrames: 8,
      animFrameOffset: 4,
      frameDuration: 100,
      loop: true,
    },
    attack: {
      resource,
      animNumFrames: 6,
      animFrameOffset: 12,
      frameDuration: 80,
      loop: false,
    },
  },
})

player.setPosition(new THREE.Vector3(0, 0, 0))
player.play()

// Switch animation
await player.setAnimation("walk")

// In render loop
animator.update(deltaTimeMs)
```

---

## SpriteParticleGenerator

A GPU-accelerated particle system that renders particles as sprite-sheet-based quads using instanced rendering. Supports auto-spawning, gravity, angular velocity, scale-over-lifetime, and fade-out.

### Import

```typescript
import {
  SpriteParticleGenerator,
  type ParticleEffectParameters,
} from "@opentui/core/3d"
```

### ParticleEffectParameters

```typescript
interface ParticleEffectParameters {
  resource: SpriteResource           // Sprite sheet resource for particle visuals
  animNumFrames?: number             // Animation frame count
  animFrameOffset?: number           // Starting frame in the sheet
  frameDuration?: number             // Duration per animation frame (ms)
  loop?: boolean                     // Loop particle animation
  scale?: number                     // Particle scale
  renderOrder?: number               // Render ordering
  depthWrite?: boolean               // Write to depth buffer
  maxParticles: number               // Maximum concurrent particles
  lifetimeMsMin: number              // Minimum particle lifetime (ms)
  lifetimeMsMax: number              // Maximum particle lifetime (ms)
  origins: THREE.Vector3[]           // Spawn origin point(s). Cycles through if multiple.
  spawnRadius: number | THREE.Vector3 // Spawn offset radius (uniform or per-axis)
  initialVelocityMin: THREE.Vector3  // Minimum initial velocity (per-axis)
  initialVelocityMax: THREE.Vector3  // Maximum initial velocity (per-axis)
  angularVelocityMin: THREE.Vector3  // Minimum angular velocity (per-axis)
  angularVelocityMax: THREE.Vector3  // Maximum angular velocity (per-axis)
  gravity?: THREE.Vector3            // Gravity force applied each frame
  randomGravityFactorMinMax?: THREE.Vector2  // Per-particle gravity randomization
  scaleOverLifeMinMax?: THREE.Vector2        // Scale from .x to .y over lifetime
  fadeOut?: boolean                  // Fade opacity to 0 over lifetime
  materialFactory?: () => NodeMaterial       // Custom material factory
}
```

### SpriteParticleGenerator Class

```typescript
class SpriteParticleGenerator {
  constructor(scene: THREE.Scene, initialBaseConfig: ParticleEffectParameters)

  // Get the number of currently alive particles
  getActiveParticleCount(): number

  // Spawn a batch of particles with optional parameter overrides
  spawnParticles(
    count: number,
    overrides?: Partial<ParticleEffectParameters>
  ): Promise<void>

  // Enable auto-spawning at a given rate (particles per second)
  setAutoSpawn(
    ratePerSecond: number,
    autoSpawnParamOverrides?: Partial<ParticleEffectParameters>
  ): void

  // Check if auto-spawn is active
  hasAutoSpawn(): boolean

  // Disable auto-spawning
  stopAutoSpawn(): void

  // Update all particles (call once per frame)
  update(deltaTimeMs: number): Promise<void>

  // Clean up all GPU resources
  dispose(): void
}
```

### Particle System Example

```typescript
import { SpriteParticleGenerator, SpriteResourceManager } from "@opentui/core/3d"
import * as THREE from "@opentui/core/3d"

const resourceManager = new SpriteResourceManager(scene)
const resource = await resourceManager.createResource({
  imagePath: "./assets/particle.png",
  sheetNumFrames: 4,
})

const particles = new SpriteParticleGenerator(scene, {
  resource,
  maxParticles: 500,
  lifetimeMsMin: 800,
  lifetimeMsMax: 2000,
  origins: [new THREE.Vector3(0, 0, 0)],
  spawnRadius: 0.5,
  initialVelocityMin: new THREE.Vector3(-2, 3, -2),
  initialVelocityMax: new THREE.Vector3(2, 8, 2),
  angularVelocityMin: new THREE.Vector3(0, 0, -1),
  angularVelocityMax: new THREE.Vector3(0, 0, 1),
  gravity: new THREE.Vector3(0, -9.8, 0),
  scaleOverLifeMinMax: new THREE.Vector2(1.0, 0.0),
  fadeOut: true,
})

// Burst spawn
await particles.spawnParticles(50)

// Continuous emission at 100 particles/sec
particles.setAutoSpawn(100)

// In render loop
await particles.update(deltaTimeMs)
```

---

## ExplodingSpriteEffect

Decomposes a sprite into a grid of fragment particles that fly outward. Each fragment retains a UV sub-region of the original sprite's current frame, producing a visual "shatter" effect.

### Import

```typescript
import {
  ExplodingSpriteEffect,
  ExplosionManager,
  DEFAULT_EXPLOSION_PARAMETERS,
  type ExplosionEffectParameters,
  type ExplosionCreationData,
  type SpriteRecreationData,
  type ExplosionHandle,
} from "@opentui/core/3d"
```

### ExplosionEffectParameters

```typescript
interface ExplosionEffectParameters {
  numRows: number                      // Grid rows for fragment subdivision
  numCols: number                      // Grid columns for fragment subdivision
  durationMs: number                   // Effect duration (ms)
  strength: number                     // Explosion force magnitude
  strengthVariation: number            // Random variation on force (0-1 range typical)
  gravity: number                      // Downward pull on fragments
  gravityScale: number                 // Multiplier on gravity
  fadeOut: boolean                     // Fade fragments over duration
  angularVelocityMin: THREE.Vector3    // Min angular velocity per fragment
  angularVelocityMax: THREE.Vector3    // Max angular velocity per fragment
  initialVelocityYBoost: number        // Extra upward kick
  zVariationStrength: number           // Depth scatter for 3D feel
  materialFactory: () => NodeMaterial  // Custom material for fragments
}

// Pre-configured defaults
const DEFAULT_EXPLOSION_PARAMETERS: ExplosionEffectParameters
```

### ExplosionCreationData

Data needed to construct an explosion from a sprite's current visual state.

```typescript
interface ExplosionCreationData {
  resource: SpriteResource
  frameUvOffset: THREE.Vector2       // UV offset of the current frame
  frameUvSize: THREE.Vector2         // UV size of the current frame
  spriteWorldTransform: THREE.Matrix4 // World-space transform of the sprite
}
```

### SpriteRecreationData

Captures the sprite's definition and transform so it can be restored after the explosion.

```typescript
interface SpriteRecreationData {
  definition: SpriteDefinition
  currentTransform: {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  }
}
```

### ExplosionHandle

Returned by `ExplosionManager.createExplosionForSprite()` to track and optionally reverse the explosion.

```typescript
interface ExplosionHandle {
  readonly effect: ExplodingSpriteEffect
  readonly recreationData: SpriteRecreationData
  hasBeenRestored: boolean
  restoreSprite: (spriteAnimator: SpriteAnimator) => Promise<TiledSprite | null>
}
```

### ExplodingSpriteEffect Class

```typescript
class ExplodingSpriteEffect {
  isActive: boolean

  constructor(
    scene: THREE.Scene,
    resource: SpriteResource,
    frameUvOffset: THREE.Vector2,
    frameUvSize: THREE.Vector2,
    spriteWorldTransform: THREE.Matrix4,
    userParams?: Partial<ExplosionEffectParameters>
  )

  // Build a reusable material template (cached by texture)
  static _buildTemplateMaterial(
    texture: THREE.DataTexture,
    params: ExplosionEffectParameters,
    materialFactory: () => NodeMaterial
  ): NodeMaterial

  // Advance the effect by deltaTimeMs
  update(deltaTimeMs: number): void

  // Clean up GPU resources
  dispose(): void
}
```

### ExplosionManager

High-level manager that creates and tracks multiple explosion effects, with optional object pooling.

```typescript
class ExplosionManager {
  constructor(scene: THREE.Scene)

  // Pre-allocate explosion effect objects for a given resource
  fillPool(
    resource: SpriteResource,
    count: number,
    params?: Partial<ExplosionEffectParameters>
  ): void

  // Explode a TiledSprite, destroying it and returning a handle
  // to optionally restore it later
  createExplosionForSprite(
    spriteToExplode: TiledSprite,
    userParams?: Partial<ExplosionEffectParameters>
  ): ExplosionHandle | null

  // Update all active explosions
  update(deltaTimeMs: number): void

  // Dispose all effects and clear the pool
  disposeAll(): void
}
```

### Explosion Example

```typescript
import { ExplosionManager, SpriteAnimator } from "@opentui/core/3d"

const explosions = new ExplosionManager(scene)
const animator = new SpriteAnimator(scene)

// Pre-fill pool for performance
explosions.fillPool(resource, 5, {
  numRows: 4,
  numCols: 4,
  durationMs: 1200,
  strength: 12,
  gravity: 6,
  fadeOut: true,
})

// Explode a sprite
const handle = explosions.createExplosionForSprite(player, {
  strength: 20,
  strengthVariation: 5,
})

// Later: restore the sprite
if (handle && !handle.hasBeenRestored) {
  const restoredSprite = await handle.restoreSprite(animator)
}

// In render loop
explosions.update(deltaTimeMs)
```

---

## PhysicsExplodingSpriteEffect

A variant of `ExplodingSpriteEffect` that uses a physics engine (via the [PhysicsWorld interface](./physics.md)) to drive fragment motion. Fragments become rigid bodies with realistic collision, damping, and restitution.

### Import

```typescript
import {
  PhysicsExplodingSpriteEffect,
  PhysicsExplosionManager,
  DEFAULT_PHYSICS_EXPLOSION_PARAMETERS,
  type PhysicsExplosionEffectParameters,
  type PhysicsExplosionCreationData,
  type PhysicsSpriteRecreationData,
  type PhysicsExplosionHandle,
} from "@opentui/core/3d"
```

### PhysicsExplosionEffectParameters

```typescript
interface PhysicsExplosionEffectParameters {
  numRows: number                      // Grid subdivision rows
  numCols: number                      // Grid subdivision columns
  durationMs: number                   // Effect duration (ms)
  explosionForce: number               // Impulse magnitude applied to fragments
  forceVariation: number               // Random variation on explosion force
  torqueStrength: number               // Rotational impulse strength
  gravityScale: number                 // Multiplier on world gravity
  fadeOut: boolean                     // Fade fragments over duration
  linearDamping: number                // Linear velocity damping
  angularDamping: number               // Angular velocity damping
  restitution: number                  // Bounciness of fragments (0-1)
  friction: number                     // Surface friction
  density: number                      // Fragment mass density
  materialFactory: () => NodeMaterial  // Custom fragment material
}

const DEFAULT_PHYSICS_EXPLOSION_PARAMETERS: PhysicsExplosionEffectParameters
```

### PhysicsExplosionCreationData

```typescript
interface PhysicsExplosionCreationData {
  resource: SpriteResource
  frameUvOffset: THREE.Vector2
  frameUvSize: THREE.Vector2
  spriteWorldTransform: THREE.Matrix4
}
```

### PhysicsSpriteRecreationData

```typescript
interface PhysicsSpriteRecreationData {
  definition: SpriteDefinition
  currentTransform: {
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
  }
}
```

### PhysicsExplosionHandle

```typescript
interface PhysicsExplosionHandle {
  readonly effect: PhysicsExplodingSpriteEffect
  readonly recreationData: PhysicsSpriteRecreationData
  hasBeenRestored: boolean
  restoreSprite: (spriteAnimator: SpriteAnimator) => Promise<TiledSprite | null>
}
```

### PhysicsExplodingSpriteEffect Class

```typescript
class PhysicsExplodingSpriteEffect {
  isActive: boolean

  constructor(
    scene: THREE.Scene,
    physicsWorld: PhysicsWorld,
    resource: SpriteResource,
    frameUvOffset: THREE.Vector2,
    frameUvSize: THREE.Vector2,
    spriteWorldTransform: THREE.Matrix4,
    userParams?: Partial<PhysicsExplosionEffectParameters>
  )

  // Get or create a cached material for a texture
  static getSharedMaterial(
    texture: THREE.DataTexture,
    materialFactory: () => NodeMaterial
  ): NodeMaterial

  update(deltaTimeMs: number): void
  dispose(): void
}
```

### PhysicsExplosionManager

```typescript
class PhysicsExplosionManager {
  constructor(scene: THREE.Scene, physicsWorld: PhysicsWorld)

  fillPool(
    resource: SpriteResource,
    count: number,
    params?: Partial<PhysicsExplosionEffectParameters>
  ): void

  createExplosionForSprite(
    spriteToExplode: TiledSprite,
    userParams?: Partial<PhysicsExplosionEffectParameters>
  ): Promise<PhysicsExplosionHandle | null>

  update(deltaTimeMs: number): void
  disposeAll(): void
}
```

### Physics Explosion Example

```typescript
import {
  PhysicsExplosionManager,
  RapierPhysicsWorld,
} from "@opentui/core/3d"
import RAPIER from "@dimforge/rapier2d-simd-compat"

// Set up physics
const rapierWorld = new RAPIER.World({ x: 0, y: -9.8 })
const physicsWorld = RapierPhysicsWorld.createFromRapierWorld(rapierWorld)

const explosions = new PhysicsExplosionManager(scene, physicsWorld)

// Explode with physics
const handle = await explosions.createExplosionForSprite(player, {
  numRows: 6,
  numCols: 6,
  explosionForce: 15,
  restitution: 0.4,
  friction: 0.3,
  density: 1.0,
  linearDamping: 0.5,
  angularDamping: 0.3,
})

// In render loop
rapierWorld.step()
explosions.update(deltaTimeMs)
```

---

## Architecture

### Timeline vs. 3D Animation

The two animation systems serve different purposes:

| Feature | Timeline Engine | SpriteAnimator / Particle System |
|---------|----------------|----------------------------------|
| **Scope** | Any JS object property | Three.js scene sprites |
| **Rendering** | Not rendering-specific | GPU-instanced rendering |
| **Import** | `@opentui/core` | `@opentui/core/3d` |
| **Use case** | UI transitions, property tweens | Game sprites, particle effects |
| **Frame sync** | CliRenderer frame callback | Manual `update(deltaTime)` call |

### GPU Instancing Pipeline

The sprite animation system uses GPU instancing to render many sprites efficiently:

```
SpriteResourceManager
    |  - Loads textures, caches resources
    |  - Creates InstanceManager per sprite type
    v
SpriteAnimator
    |  - Resolves animation definitions
    |  - Assigns instance slots per animation state
    v
TiledSprite
    |  - Manages multiple Animation objects
    |  - Updates transform + frame index per tick
    v
InstancedMesh (GPU)
    |  - Single draw call for all sprites of same type
    |  - Custom buffer attributes: frame index, flip, UV offset
    v
NodeMaterial (WebGPU)
    - Samples correct sprite sheet tile per-instance
    - Applied via Three.js WebGPU material system
```

### Explosion Decomposition

Both `ExplodingSpriteEffect` and `PhysicsExplodingSpriteEffect` work by:

1. Reading the sprite's current frame UV coordinates
2. Subdividing the frame into a `numRows x numCols` grid
3. Creating one instanced-mesh fragment per grid cell with the corresponding UV sub-region
4. Applying outward forces (either parametric or physics-simulated)
5. Fading and removing fragments over `durationMs`

The `ExplosionHandle` / `PhysicsExplosionHandle` pattern allows the caller to restore the original sprite after the effect completes, enabling "respawn" workflows.

---

## Related Documentation

- [3D Rendering System](./3d.md) -- CLICanvas, ThreeRenderable, ThreeCliRenderer, textures, sprites
- [Physics System](./physics.md) -- PhysicsWorld interface, Rapier and Planck adapters
- [Core API](./core-api.md) -- CliRenderer, Renderable, OptimizedBuffer
