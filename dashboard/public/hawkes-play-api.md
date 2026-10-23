# Hawkes Play Runtime API Reference

The Hawkes Play Runtime is a script layer over Babylon.js that makes it simple to build 3D web games collaboratively.

## Quick Start

```javascript
import { HawkesPlay } from '/public/hawkes-play.js';

// Create a game instance
const game = new HawkesPlay();

// Add entities
game.scene.addEntity({
  name: 'player',
  type: 'sphere',
  position: [0, 2, 0],
  material: { color: [1, 0, 0] },
  physics: { mass: 1 }
});

// Add game logic
game.onUpdate((deltaTime) => {
  const player = game.getEntity('player');
  if (game.input.isKeyDown('w')) {
    player.move(0, 0, 5 * deltaTime);
  }
});

// Start the game loop
game.start();
```

## Core Classes

### HawkesPlay

The main game class that manages the engine, scene, and runtime.

#### Constructor

```javascript
new HawkesPlay(canvasId = 'gameCanvas')
```

- `canvasId`: ID of the canvas element (creates one if not found)

#### Properties

- `engine` - Babylon.js Engine instance
- `camera` - Main camera (ArcRotateCamera)
- `scene` - Scene API for managing entities
- `input` - Input manager for keyboard/mouse
- `assets` - Asset manager for loading resources
- `entities` - Map of all entities by name

#### Methods

##### `start()`

Starts the game loop.

```javascript
game.start();
```

##### `stop()`

Stops the game loop.

```javascript
game.stop();
```

##### `onUpdate(callback)`

Registers a callback that runs every frame.

```javascript
game.onUpdate((deltaTime) => {
  // Game logic here
  // deltaTime is in seconds
});
```

##### `getEntity(name)`

Gets an entity by name.

```javascript
const player = game.getEntity('player');
```

##### `removeEntity(name)`

Removes an entity from the scene.

```javascript
game.removeEntity('enemy1');
```

---

## Scene API

Accessed via `game.scene`, provides methods for managing the game world.

### `addEntity(config)`

Adds a new entity to the scene.

```javascript
game.scene.addEntity({
  name: 'box1',              // Required: unique name
  type: 'box',               // Entity type
  position: [0, 1, 0],       // [x, y, z]
  rotation: [0, 0, 0],       // [x, y, z] in radians
  scale: [1, 1, 1],          // [x, y, z] or single number
  material: {                // Material properties
    color: [1, 0, 0],        // RGB 0-1
    emissive: [0, 0, 0],
    alpha: 1.0,
    texture: '/path/to/texture.png'
  },
  physics: {                 // Physics properties
    mass: 1,
    restitution: 0.3,        // Bounciness
    friction: 0.5,
    type: BABYLON.PhysicsImpostor.BoxImpostor
  }
});
```

**Entity Types:**
- `'box'` - Cube
- `'sphere'` - Sphere
- `'cylinder'` - Cylinder
- `'plane'` - Flat plane
- `'ground'` - Ground plane

### `getEntity(name)`

Gets an entity by name.

```javascript
const player = game.scene.getEntity('player');
```

### `removeEntity(name)`

Removes an entity.

```javascript
game.scene.removeEntity('enemy1');
```

### `setBackgroundColor(r, g, b, a)`

Sets the scene background color (0-1 range).

```javascript
game.scene.setBackgroundColor(0.2, 0.3, 0.5, 1.0);
```

### `setCameraPosition(x, y, z)`

Moves the camera to a position.

```javascript
game.scene.setCameraPosition(0, 5, -10);
```

### `setCameraTarget(x, y, z)`

Points the camera at a target.

```javascript
game.scene.setCameraTarget(0, 0, 0);
```

### `addDirectionalLight(name, direction)`

Creates a directional light (like sunlight).

```javascript
game.scene.addDirectionalLight('sun', [0, -1, 0]);
```

### `addPointLight(name, position)`

Creates a point light.

```javascript
game.scene.addPointLight('lamp', [5, 3, 5]);
```

---

## Entity

Represents a game object. Accessed via `game.getEntity(name)`.

### Properties

- `name` - Entity name
- `mesh` - Babylon.js mesh object
- `scene` - Babylon.js scene reference
- `onUpdate` - Custom update function

### Methods

##### `setMaterial(props)`

Updates the entity's material.

```javascript
entity.setMaterial({
  color: [0, 1, 0],
  alpha: 0.5,
  texture: '/textures/brick.png'
});
```

##### `enablePhysics(props)`

Enables physics simulation.

```javascript
entity.enablePhysics({
  mass: 2,
  restitution: 0.8,
  friction: 0.2,
  type: BABYLON.PhysicsImpostor.SphereImpostor
});
```

##### `applyForce(x, y, z)`

Applies a force (requires physics enabled).

```javascript
entity.applyForce(0, 100, 0); // Jump
```

##### `setVelocity(x, y, z)`

Sets velocity directly (requires physics).

```javascript
entity.setVelocity(5, 0, 0); // Move right at 5 units/sec
```

##### `getPosition()`

Returns `[x, y, z]` position array.

```javascript
const [x, y, z] = entity.getPosition();
```

##### `setPosition(x, y, z)`

Sets position.

```javascript
entity.setPosition(0, 10, 0);
```

##### `move(dx, dy, dz)`

Moves relative to current position.

```javascript
entity.move(0, 0, 1); // Move forward 1 unit
```

##### `rotate(dx, dy, dz)`

Rotates in radians.

```javascript
entity.rotate(0, Math.PI / 4, 0); // Rotate 45° around Y
```

##### `lookAt(x, y, z)`

Points the entity at a target.

```javascript
entity.lookAt(playerX, playerY, playerZ);
```

---

## Input Manager

Accessed via `game.input`, handles keyboard and mouse input.

### Methods

##### `isKeyDown(key)`

Checks if a key is pressed.

```javascript
if (game.input.isKeyDown('w')) {
  // Move forward
}
if (game.input.isKeyDown('space')) {
  // Jump
}
```

**Common keys:** `'w'`, `'a'`, `'s'`, `'d'`, `'space'`, `'shift'`, `'arrowup'`, `'arrowdown'`, etc.

##### `getMousePosition()`

Returns `{ x, y }` mouse coordinates.

```javascript
const { x, y } = game.input.getMousePosition();
```

##### `isMouseButtonDown(button)`

Checks if mouse button is pressed.

```javascript
if (game.input.isMouseButtonDown('left')) {
  // Fire weapon
}
```

**Buttons:** `'left'`, `'right'`

---

## Asset Manager

Accessed via `game.assets`, loads 3D models and textures.

### Methods

##### `async loadModel(url, name)`

Loads a GLB/GLTF model.

```javascript
const meshes = await game.assets.loadModel('/models/character.glb', 'hero');
// Meshes are automatically added to the scene
```

##### `loadTexture(url, name)`

Loads a texture.

```javascript
const texture = game.assets.loadTexture('/textures/wood.png', 'wood');
```

##### `get(name)`

Retrieves a loaded asset.

```javascript
const heroMeshes = game.assets.get('hero');
```

---

## Complete Example: Simple FPS Controller

```javascript
import { HawkesPlay } from '/public/hawkes-play.js';

const game = new HawkesPlay();

// Create player
game.scene.addEntity({
  name: 'player',
  type: 'box',
  position: [0, 1, 0],
  scale: [0.5, 1.8, 0.5],
  material: { color: [0.2, 0.5, 1] },
  physics: { mass: 10, friction: 0 }
});

// Create some obstacles
for (let i = 0; i < 5; i++) {
  game.scene.addEntity({
    name: `obstacle${i}`,
    type: 'cylinder',
    position: [Math.random() * 10 - 5, 0.5, Math.random() * 10 - 5],
    scale: [0.5, 1, 0.5],
    material: { color: [0.8, 0.2, 0.2] },
    physics: { mass: 0 } // Static (mass 0)
  });
}

// Player movement
const speed = 5;
const jumpForce = 150;

game.onUpdate((dt) => {
  const player = game.getEntity('player');
  const [x, y, z] = player.getPosition();

  // WASD movement
  if (game.input.isKeyDown('w')) player.move(0, 0, speed * dt);
  if (game.input.isKeyDown('s')) player.move(0, 0, -speed * dt);
  if (game.input.isKeyDown('a')) player.move(-speed * dt, 0, 0);
  if (game.input.isKeyDown('d')) player.move(speed * dt, 0, 0);

  // Jump
  if (game.input.isKeyDown('space') && y < 1.2) {
    player.applyForce(0, jumpForce, 0);
  }

  // Camera follows player
  game.scene.setCameraTarget(x, y, z);
});

game.start();
```

---

## Using Generated Assets

Assets generated with Hawkes Gen tools can be used in your game:

```javascript
// Load a generated model
const asset = await game.assets.loadModel(
  '/v1/assets/a_abc123/file?download=1',
  'character'
);

// Use a generated texture
const player = game.scene.addEntity({
  name: 'player',
  type: 'plane',
  material: {
    texture: '/v1/assets/a_xyz456/file'
  }
});
```

---

## Tips

1. **Physics:** Set `mass: 0` for static objects (walls, ground)
2. **Performance:** Limit entities to ~100-200 for smooth 60fps
3. **Debugging:** Use browser console and `console.log(entity.getPosition())`
4. **Multiplayer:** Coming soon via WebRTC data channels
5. **Mobile:** Touch controls coming soon

## Next Steps

- Browse starter templates in the editor
- Generate assets with the AI assistant
- Join the community Discord for help
- Read the Babylon.js docs for advanced features
