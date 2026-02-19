# Physics System

OpenTUI defines a lightweight, engine-agnostic 2D physics interface and ships adapter implementations for two popular physics engines: **Rapier** and **Planck.js**. The physics system is designed to drive sprite fragment motion in explosion effects, but the interface is general enough for any 2D rigid-body simulation.

## Table of Contents

- [Physics Interface](#physics-interface)
  - [PhysicsVector2](#physicsvector2)
  - [PhysicsRigidBodyDesc](#physicsrigidbodydesc)
  - [PhysicsColliderDesc](#physicscolliderdesc)
  - [PhysicsRigidBody](#physicsrigidbody)
  - [PhysicsWorld](#physicsworld)
- [Rapier Adapter](#rapier-adapter)
  - [RapierRigidBody](#rapierrigidbody)
  - [RapierPhysicsWorld](#rapierphysicsworld)
- [Planck Adapter](#planck-adapter)
  - [PlanckRigidBody](#planckrigidbody)
  - [PlanckPhysicsWorld](#planckphysicsworld)
- [Usage with Explosion Effects](#usage-with-explosion-effects)
- [Choosing an Engine](#choosing-an-engine)
- [Architecture](#architecture)
- [Related Documentation](#related-documentation)

---

## Physics Interface

The physics interface defines the minimal contract for 2D rigid-body physics. All types live in `@opentui/core/3d` and are engine-agnostic.

### PhysicsVector2

A simple 2D vector used for positions, velocities, and forces.

```typescript
interface PhysicsVector2 {
  x: number
  y: number
}
```

### PhysicsRigidBodyDesc

Descriptor for creating a new rigid body.

```typescript
interface PhysicsRigidBodyDesc {
  translation: PhysicsVector2    // Initial position
  linearDamping: number          // Linear velocity damping factor
  angularDamping: number         // Angular velocity damping factor
}
```

### PhysicsColliderDesc

Descriptor for creating a box collider attached to a rigid body.

```typescript
interface PhysicsColliderDesc {
  width: number           // Collider width
  height: number          // Collider height
  restitution: number     // Bounciness (0 = no bounce, 1 = perfect bounce)
  friction: number        // Surface friction coefficient
  density: number         // Mass density (determines mass from collider area)
}
```

### PhysicsRigidBody

Interface for interacting with a created rigid body.

```typescript
interface PhysicsRigidBody {
  // Apply a linear impulse at the center of mass
  applyImpulse(force: PhysicsVector2): void

  // Apply a rotational impulse
  applyTorqueImpulse(torque: number): void

  // Get current position
  getTranslation(): PhysicsVector2

  // Get current rotation angle (radians)
  getRotation(): number
}
```

### PhysicsWorld

The top-level physics simulation interface.

```typescript
interface PhysicsWorld {
  // Create a dynamic rigid body from a descriptor
  createRigidBody(desc: PhysicsRigidBodyDesc): PhysicsRigidBody

  // Attach a box collider to a rigid body
  createCollider(
    colliderDesc: PhysicsColliderDesc,
    rigidBody: PhysicsRigidBody
  ): void

  // Remove a rigid body (and its colliders) from the simulation
  removeRigidBody(rigidBody: PhysicsRigidBody): void
}
```

---

## Rapier Adapter

Adapts the [Rapier 2D](https://rapier.rs/) physics engine (via `@dimforge/rapier2d-simd-compat`) to the `PhysicsWorld` interface.

**Dependency**: `@dimforge/rapier2d-simd-compat` ^0.17.3 (optional)

### Import

```typescript
import { RapierPhysicsWorld, RapierRigidBody } from "@opentui/core/3d"
import RAPIER from "@dimforge/rapier2d-simd-compat"
```

### RapierRigidBody

Wraps a Rapier `RAPIER.RigidBody` to implement `PhysicsRigidBody`.

```typescript
class RapierRigidBody implements PhysicsRigidBody {
  constructor(rapierBody: RAPIER.RigidBody)

  applyImpulse(force: PhysicsVector2): void
  applyTorqueImpulse(torque: number): void
  getTranslation(): PhysicsVector2
  getRotation(): number

  // Access the underlying Rapier body for engine-specific features
  get nativeBody(): RAPIER.RigidBody
}
```

### RapierPhysicsWorld

Wraps a Rapier `RAPIER.World` to implement `PhysicsWorld`.

```typescript
class RapierPhysicsWorld implements PhysicsWorld {
  constructor(rapierWorld: RAPIER.World)

  createRigidBody(desc: PhysicsRigidBodyDesc): PhysicsRigidBody
  createCollider(
    colliderDesc: PhysicsColliderDesc,
    rigidBody: PhysicsRigidBody
  ): void
  removeRigidBody(rigidBody: PhysicsRigidBody): void

  // Factory method
  static createFromRapierWorld(rapierWorld: RAPIER.World): RapierPhysicsWorld
}
```

### Rapier Example

```typescript
import { RapierPhysicsWorld } from "@opentui/core/3d"
import RAPIER from "@dimforge/rapier2d-simd-compat"

// Initialize Rapier
await RAPIER.init()

// Create world with gravity
const rapierWorld = new RAPIER.World({ x: 0, y: -9.8 })
const physics = RapierPhysicsWorld.createFromRapierWorld(rapierWorld)

// Create a dynamic body
const body = physics.createRigidBody({
  translation: { x: 0, y: 10 },
  linearDamping: 0.1,
  angularDamping: 0.05,
})

// Attach a box collider
physics.createCollider({
  width: 1,
  height: 1,
  restitution: 0.5,
  friction: 0.3,
  density: 1.0,
}, body)

// Apply force
body.applyImpulse({ x: 5, y: 0 })
body.applyTorqueImpulse(0.2)

// Step the simulation
rapierWorld.step()

// Read state
const pos = body.getTranslation()    // { x: ..., y: ... }
const angle = body.getRotation()     // radians
```

---

## Planck Adapter

Adapts the [Planck.js](https://piqnt.com/planck.js/) physics engine to the `PhysicsWorld` interface.

**Dependency**: `planck` ^1.4.2 (optional)

### Import

```typescript
import { PlanckPhysicsWorld, PlanckRigidBody } from "@opentui/core/3d"
import * as planck from "planck"
```

### PlanckRigidBody

Wraps a Planck `planck.Body` to implement `PhysicsRigidBody`.

```typescript
class PlanckRigidBody implements PhysicsRigidBody {
  constructor(planckBody: planck.Body)

  applyImpulse(force: PhysicsVector2): void
  applyTorqueImpulse(torque: number): void
  getTranslation(): PhysicsVector2
  getRotation(): number

  // Access the underlying Planck body for engine-specific features
  get nativeBody(): planck.Body
}
```

### PlanckPhysicsWorld

Wraps a Planck `planck.World` to implement `PhysicsWorld`.

```typescript
class PlanckPhysicsWorld implements PhysicsWorld {
  constructor(planckWorld: planck.World)

  createRigidBody(desc: PhysicsRigidBodyDesc): PhysicsRigidBody
  createCollider(
    colliderDesc: PhysicsColliderDesc,
    rigidBody: PhysicsRigidBody
  ): void
  removeRigidBody(rigidBody: PhysicsRigidBody): void

  // Factory method
  static createFromPlanckWorld(planckWorld: planck.World): PlanckPhysicsWorld
}
```

### Planck Example

```typescript
import { PlanckPhysicsWorld } from "@opentui/core/3d"
import * as planck from "planck"

// Create world with gravity
const planckWorld = planck.World({ x: 0, y: -9.8 })
const physics = PlanckPhysicsWorld.createFromPlanckWorld(planckWorld)

// Create a dynamic body
const body = physics.createRigidBody({
  translation: { x: 5, y: 20 },
  linearDamping: 0.2,
  angularDamping: 0.1,
})

// Attach a collider
physics.createCollider({
  width: 0.5,
  height: 0.5,
  restitution: 0.7,
  friction: 0.4,
  density: 2.0,
}, body)

// Step the simulation (Planck uses fixed timestep)
planckWorld.step(1 / 60)

// Read state
const pos = body.getTranslation()
const angle = body.getRotation()

// Clean up
physics.removeRigidBody(body)
```

---

## Usage with Explosion Effects

The primary consumer of the physics interface is `PhysicsExplodingSpriteEffect`, which creates a rigid body for each fragment of an exploding sprite. See [Animation: PhysicsExplodingSpriteEffect](./animation.md#physicsexplodingspriteeffect) for the full API.

```typescript
import {
  PhysicsExplosionManager,
  RapierPhysicsWorld,
  SpriteAnimator,
} from "@opentui/core/3d"
import RAPIER from "@dimforge/rapier2d-simd-compat"

await RAPIER.init()
const rapierWorld = new RAPIER.World({ x: 0, y: -9.8 })
const physicsWorld = RapierPhysicsWorld.createFromRapierWorld(rapierWorld)

const explosionManager = new PhysicsExplosionManager(scene, physicsWorld)

// Explode a sprite with physics-driven fragments
const handle = await explosionManager.createExplosionForSprite(sprite, {
  numRows: 4,
  numCols: 4,
  explosionForce: 12,
  restitution: 0.3,
  linearDamping: 0.4,
  durationMs: 2000,
})

// Render loop
function animate(deltaMs: number) {
  rapierWorld.step()          // Step physics
  explosionManager.update(deltaMs)  // Sync visuals to physics state
}
```

The non-physics `ExplodingSpriteEffect` does not require a `PhysicsWorld` and uses parametric motion instead. Use it when you want explosion visuals without the overhead of a full physics simulation.

---

## Choosing an Engine

Both adapters implement the same `PhysicsWorld` interface, so they are interchangeable. Choose based on your requirements:

| Feature | Rapier | Planck.js |
|---------|--------|-----------|
| **Language** | Rust (via WASM) | Pure JavaScript |
| **Performance** | Higher (SIMD WASM) | Lower but no WASM dependency |
| **Bundle size** | Larger (~1MB WASM) | Smaller (~100KB) |
| **SIMD support** | Yes (`simd-compat` variant) | No |
| **API style** | Descriptor-based | Builder-based |
| **Best for** | Many fragments, complex scenes | Simple effects, smaller builds |

Both engines handle the typical explosion use case (tens to low hundreds of rigid bodies) without issues. Rapier pulls ahead when fragment counts are high or when the physics world has other objects (e.g., ground planes, walls) that fragments interact with.

---

## Architecture

### Adapter Pattern

The physics system uses a classic adapter/bridge pattern:

```
PhysicsWorld (interface)          PhysicsRigidBody (interface)
    |                                  |
    +-- RapierPhysicsWorld             +-- RapierRigidBody
    |       wraps RAPIER.World         |       wraps RAPIER.RigidBody
    |                                  |
    +-- PlanckPhysicsWorld             +-- PlanckRigidBody
            wraps planck.World                 wraps planck.Body
```

This allows `PhysicsExplodingSpriteEffect` and `PhysicsExplosionManager` to work with either engine without any conditional logic. The `nativeBody` property on each adapter provides an escape hatch for engine-specific features when needed.

### Integration Flow

```
PhysicsExplosionManager
    |
    |  createExplosionForSprite(sprite)
    v
PhysicsExplodingSpriteEffect
    |
    |  For each grid fragment:
    |    1. physicsWorld.createRigidBody(desc)
    |    2. physicsWorld.createCollider(desc, body)
    |    3. body.applyImpulse(outwardForce)
    |    4. body.applyTorqueImpulse(spin)
    v
update(deltaTimeMs)
    |
    |  For each fragment:
    |    1. pos = body.getTranslation()
    |    2. rot = body.getRotation()
    |    3. Update instanced mesh transform
    |    4. If expired: physicsWorld.removeRigidBody(body)
    v
Terminal Output (via ThreeRenderable pipeline)
```

### Simulation Stepping

The `PhysicsWorld` interface does not include a `step()` method. This is intentional -- the physics world simulation step is engine-specific (Rapier uses `world.step()`, Planck uses `world.step(dt)`) and should be called by the application before calling `explosionManager.update()`. This gives the application full control over timestep size and substep count.

---

## Related Documentation

- [3D Rendering System](./3d.md) -- CLICanvas, ThreeRenderable, ThreeCliRenderer, textures, sprites
- [Animation System](./animation.md) -- Timeline, SpriteAnimator, particle generators, explosion effects
- [Core API](./core-api.md) -- CliRenderer, Renderable, OptimizedBuffer
