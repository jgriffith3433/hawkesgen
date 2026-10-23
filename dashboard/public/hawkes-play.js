/**
 * Hawkes Play Runtime v1.0
 * A script layer over Babylon.js for building web games collaboratively.
 *
 * Usage:
 *   import { HawkesPlay } from '/public/hawkes-play.js';
 *   const game = new HawkesPlay();
 *   game.scene.addEntity({ name: 'player', type: 'box', position: [0, 1, 0] });
 *   game.start();
 */

export class HawkesPlay {
  constructor(canvasId = 'gameCanvas') {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.id = canvasId;
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.display = 'block';
      document.body.appendChild(this.canvas);
    }

    // Initialize Babylon engine and scene
    this.engine = new BABYLON.Engine(this.canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this._scene = new BABYLON.Scene(this.engine);
    this._scene.clearColor = new BABYLON.Color4(0.2, 0.2, 0.3, 1);

    // Camera setup
    this.camera = new BABYLON.ArcRotateCamera('camera', 0, 0, 10, new BABYLON.Vector3(0, 0, 0), this._scene);
    this.camera.setPosition(new BABYLON.Vector3(0, 5, -10));
    this.camera.attachControl(this.canvas, true);

    // Light setup
    const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), this._scene);
    light.intensity = 0.7;

    // Ground
    const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 20, height: 20 }, this._scene);
    ground.material = new BABYLON.StandardMaterial('groundMat', this._scene);
    ground.material.diffuseColor = new BABYLON.Color3(0.3, 0.5, 0.3);

    // Entity management
    this.entities = new Map();
    this._nextEntityId = 1;

    // Input handling
    this.input = new InputManager(this._scene);

    // Physics
    this._scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), new BABYLON.CannonJSPlugin());

    // Asset loading
    this.assets = new AssetManager(this._scene);

    // Scene API
    this.scene = new SceneAPI(this);

    // Runtime state
    this._running = false;
    this._updateCallbacks = [];
  }

  /**
   * Start the game loop
   */
  start() {
    if (this._running) return;
    this._running = true;

    this.engine.runRenderLoop(() => {
      const deltaTime = this.engine.getDeltaTime() / 1000;

      // Update all entities
      for (const entity of this.entities.values()) {
        if (entity.onUpdate) {
          entity.onUpdate(deltaTime);
        }
      }

      // Call custom update callbacks
      for (const cb of this._updateCallbacks) {
        cb(deltaTime);
      }

      this._scene.render();
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      this.engine.resize();
    });
  }

  /**
   * Stop the game loop
   */
  stop() {
    this._running = false;
    this.engine.stopRenderLoop();
  }

  /**
   * Register a custom update callback
   */
  onUpdate(callback) {
    this._updateCallbacks.push(callback);
  }

  /**
   * Get an entity by name
   */
  getEntity(name) {
    return this.entities.get(name);
  }

  /**
   * Remove an entity
   */
  removeEntity(name) {
    const entity = this.entities.get(name);
    if (entity && entity.mesh) {
      entity.mesh.dispose();
    }
    this.entities.delete(name);
  }
}

/**
 * Scene API for managing game entities and world
 */
class SceneAPI {
  constructor(game) {
    this.game = game;
  }

  /**
   * Add a new entity to the scene
   * @param {Object} config - Entity configuration
   * @param {string} config.name - Unique entity name
   * @param {string} config.type - Entity type (box, sphere, cylinder, etc.)
   * @param {Array} config.position - [x, y, z] position
   * @param {Array} config.rotation - [x, y, z] rotation in radians
   * @param {Array} config.scale - [x, y, z] scale
   * @param {Object} config.material - Material properties
   * @param {Object} config.physics - Physics properties
   * @returns {Entity} The created entity
   */
  addEntity(config) {
    if (this.game.entities.has(config.name)) {
      throw new Error(`Entity "${config.name}" already exists`);
    }

    const entity = new Entity(this.game._scene, config);
    this.game.entities.set(config.name, entity);
    return entity;
  }

  /**
   * Get an entity by name
   */
  getEntity(name) {
    return this.game.getEntity(name);
  }

  /**
   * Remove an entity
   */
  removeEntity(name) {
    this.game.removeEntity(name);
  }

  /**
   * Set background color
   */
  setBackgroundColor(r, g, b, a = 1) {
    this.game._scene.clearColor = new BABYLON.Color4(r, g, b, a);
  }

  /**
   * Set camera position
   */
  setCameraPosition(x, y, z) {
    this.game.camera.setPosition(new BABYLON.Vector3(x, y, z));
  }

  /**
   * Set camera target
   */
  setCameraTarget(x, y, z) {
    this.game.camera.setTarget(new BABYLON.Vector3(x, y, z));
  }

  /**
   * Create a directional light
   */
  addDirectionalLight(name, direction) {
    const light = new BABYLON.DirectionalLight(name, new BABYLON.Vector3(...direction), this.game._scene);
    return light;
  }

  /**
   * Create a point light
   */
  addPointLight(name, position) {
    const light = new BABYLON.PointLight(name, new BABYLON.Vector3(...position), this.game._scene);
    return light;
  }
}

/**
 * Entity represents a game object in the scene
 */
class Entity {
  constructor(scene, config) {
    this.name = config.name;
    this.scene = scene;
    this.onUpdate = null;

    // Create mesh based on type
    const type = config.type || 'box';
    const meshConfig = config.meshConfig || {};

    switch (type) {
      case 'box':
        this.mesh = BABYLON.MeshBuilder.CreateBox(config.name, meshConfig, scene);
        break;
      case 'sphere':
        this.mesh = BABYLON.MeshBuilder.CreateSphere(config.name, meshConfig, scene);
        break;
      case 'cylinder':
        this.mesh = BABYLON.MeshBuilder.CreateCylinder(config.name, meshConfig, scene);
        break;
      case 'plane':
        this.mesh = BABYLON.MeshBuilder.CreatePlane(config.name, meshConfig, scene);
        break;
      case 'ground':
        this.mesh = BABYLON.MeshBuilder.CreateGround(config.name, meshConfig, scene);
        break;
      default:
        throw new Error(`Unknown entity type: ${type}`);
    }

    // Set position
    if (config.position) {
      this.mesh.position = new BABYLON.Vector3(...config.position);
    }

    // Set rotation
    if (config.rotation) {
      this.mesh.rotation = new BABYLON.Vector3(...config.rotation);
    }

    // Set scale
    if (config.scale) {
      if (Array.isArray(config.scale)) {
        this.mesh.scaling = new BABYLON.Vector3(...config.scale);
      } else {
        this.mesh.scaling = new BABYLON.Vector3(config.scale, config.scale, config.scale);
      }
    }

    // Apply material
    if (config.material) {
      this.setMaterial(config.material);
    }

    // Apply physics
    if (config.physics) {
      this.enablePhysics(config.physics);
    }
  }

  /**
   * Set material properties
   */
  setMaterial(props) {
    const mat = new BABYLON.StandardMaterial(this.name + '_mat', this.scene);

    if (props.color) {
      mat.diffuseColor = new BABYLON.Color3(...props.color);
    }
    if (props.emissive) {
      mat.emissiveColor = new BABYLON.Color3(...props.emissive);
    }
    if (props.specular) {
      mat.specularColor = new BABYLON.Color3(...props.specular);
    }
    if (props.alpha !== undefined) {
      mat.alpha = props.alpha;
    }
    if (props.texture) {
      mat.diffuseTexture = new BABYLON.Texture(props.texture, this.scene);
    }

    this.mesh.material = mat;
  }

  /**
   * Enable physics on this entity
   */
  enablePhysics(props) {
    const mass = props.mass !== undefined ? props.mass : 1;
    const restitution = props.restitution !== undefined ? props.restitution : 0.3;
    const friction = props.friction !== undefined ? props.friction : 0.5;

    this.mesh.physicsImpostor = new BABYLON.PhysicsImpostor(
      this.mesh,
      props.type || BABYLON.PhysicsImpostor.BoxImpostor,
      { mass, restitution, friction },
      this.scene
    );
  }

  /**
   * Apply a force to the entity (requires physics)
   */
  applyForce(x, y, z) {
    if (this.mesh.physicsImpostor) {
      this.mesh.physicsImpostor.applyForce(
        new BABYLON.Vector3(x, y, z),
        this.mesh.getAbsolutePosition()
      );
    }
  }

  /**
   * Set velocity (requires physics)
   */
  setVelocity(x, y, z) {
    if (this.mesh.physicsImpostor) {
      this.mesh.physicsImpostor.setLinearVelocity(new BABYLON.Vector3(x, y, z));
    }
  }

  /**
   * Get current position
   */
  getPosition() {
    return [this.mesh.position.x, this.mesh.position.y, this.mesh.position.z];
  }

  /**
   * Set position
   */
  setPosition(x, y, z) {
    this.mesh.position.set(x, y, z);
  }

  /**
   * Move relative to current position
   */
  move(dx, dy, dz) {
    this.mesh.position.x += dx;
    this.mesh.position.y += dy;
    this.mesh.position.z += dz;
  }

  /**
   * Rotate the entity
   */
  rotate(dx, dy, dz) {
    this.mesh.rotation.x += dx;
    this.mesh.rotation.y += dy;
    this.mesh.rotation.z += dz;
  }

  /**
   * Look at a target position
   */
  lookAt(x, y, z) {
    this.mesh.lookAt(new BABYLON.Vector3(x, y, z));
  }
}

/**
 * Input manager for handling keyboard and mouse
 */
class InputManager {
  constructor(scene) {
    this.scene = scene;
    this.keys = {};
    this.mouse = { x: 0, y: 0, leftButton: false, rightButton: false };

    // Keyboard events
    window.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      this.keys[e.code] = true;
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
      this.keys[e.code] = false;
    });

    // Mouse events
    scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE) {
        this.mouse.x = pointerInfo.event.clientX;
        this.mouse.y = pointerInfo.event.clientY;
      } else if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
        if (pointerInfo.event.button === 0) this.mouse.leftButton = true;
        if (pointerInfo.event.button === 2) this.mouse.rightButton = true;
      } else if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERUP) {
        if (pointerInfo.event.button === 0) this.mouse.leftButton = false;
        if (pointerInfo.event.button === 2) this.mouse.rightButton = false;
      }
    });
  }

  /**
   * Check if a key is currently pressed
   */
  isKeyDown(key) {
    return !!this.keys[key.toLowerCase()];
  }

  /**
   * Get mouse position
   */
  getMousePosition() {
    return { x: this.mouse.x, y: this.mouse.y };
  }

  /**
   * Check if mouse button is down
   */
  isMouseButtonDown(button = 'left') {
    return button === 'left' ? this.mouse.leftButton : this.mouse.rightButton;
  }
}

/**
 * Asset manager for loading models, textures, and audio
 */
class AssetManager {
  constructor(scene) {
    this.scene = scene;
    this.loaded = new Map();
  }

  /**
   * Load a 3D model (GLB/GLTF)
   */
  async loadModel(url, name) {
    return new Promise((resolve, reject) => {
      BABYLON.SceneLoader.ImportMesh('', url, '', this.scene, (meshes) => {
        this.loaded.set(name, meshes);
        resolve(meshes);
      }, null, (scene, message) => {
        reject(new Error(message));
      });
    });
  }

  /**
   * Load a texture
   */
  loadTexture(url, name) {
    const texture = new BABYLON.Texture(url, this.scene);
    this.loaded.set(name, texture);
    return texture;
  }

  /**
   * Get a loaded asset
   */
  get(name) {
    return this.loaded.get(name);
  }
}
