// Starter templates for new games

export type GameTemplate = {
  id: string;
  name: string;
  description: string;
  files: Record<string, string>; // path -> content
};

export const GAME_TEMPLATES: GameTemplate[] = [
  {
    id: 'blank',
    name: 'Blank Game',
    description: 'Empty project with just the runtime',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Game</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #gameCanvas {
      width: 100%;
      height: 100vh;
      display: block;
    }
  </style>
  <script src="https://cdn.babylonjs.com/babylon.js"></script>
  <script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>
  <script src="https://cdn.babylonjs.com/cannon.js"></script>
</head>
<body>
  <canvas id="gameCanvas"></canvas>
  <script type="module" src="./game.js"></script>
</body>
</html>`,
      'game.js': `import { HawkesPlay } from '/public/hawkes-play.js';

const game = new HawkesPlay();

// Your game code here

game.start();
`,
    },
  },
  {
    id: 'fps',
    name: 'First-Person Game',
    description: 'FPS controller with WASD movement and jump',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FPS Game</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #gameCanvas {
      width: 100%;
      height: 100vh;
      display: block;
    }
    #hud {
      position: absolute;
      top: 20px;
      left: 20px;
      color: white;
      font-size: 18px;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
    }
  </style>
  <script src="https://cdn.babylonjs.com/babylon.js"></script>
  <script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>
  <script src="https://cdn.babylonjs.com/cannon.js"></script>
</head>
<body>
  <canvas id="gameCanvas"></canvas>
  <div id="hud">
    <div>WASD - Move</div>
    <div>Space - Jump</div>
  </div>
  <script type="module" src="./game.js"></script>
</body>
</html>`,
      'game.js': `import { HawkesPlay } from '/public/hawkes-play.js';

const game = new HawkesPlay();

// Sky color
game.scene.setBackgroundColor(0.4, 0.6, 0.9, 1);

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
for (let i = 0; i < 8; i++) {
  const x = (Math.random() - 0.5) * 15;
  const z = (Math.random() - 0.5) * 15;
  game.scene.addEntity({
    name: \`obstacle\${i}\`,
    type: 'cylinder',
    position: [x, 1, z],
    scale: [0.5, 2, 0.5],
    material: { color: [0.8, 0.3, 0.2] },
    physics: { mass: 0 }
  });
}

// Movement constants
const speed = 5;
const jumpForce = 200;

// Game loop
game.onUpdate((dt) => {
  const player = game.getEntity('player');
  const [x, y, z] = player.getPosition();

  // WASD movement
  if (game.input.isKeyDown('w')) player.move(0, 0, speed * dt);
  if (game.input.isKeyDown('s')) player.move(0, 0, -speed * dt);
  if (game.input.isKeyDown('a')) player.move(-speed * dt, 0, 0);
  if (game.input.isKeyDown('d')) player.move(speed * dt, 0, 0);

  // Jump (only when on ground)
  if (game.input.isKeyDown('space') && y < 1.2) {
    player.applyForce(0, jumpForce, 0);
  }

  // Camera follows player
  game.scene.setCameraTarget(x, y, z);
  game.scene.setCameraPosition(x, y + 3, z - 5);
});

game.start();
`,
    },
  },
  {
    id: 'platformer',
    name: '3D Platformer',
    description: 'Side-scrolling platformer with collectibles',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Platformer</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #gameCanvas {
      width: 100%;
      height: 100vh;
      display: block;
    }
    #hud {
      position: absolute;
      top: 20px;
      right: 20px;
      color: white;
      font-size: 24px;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
    }
  </style>
  <script src="https://cdn.babylonjs.com/babylon.js"></script>
  <script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>
  <script src="https://cdn.babylonjs.com/cannon.js"></script>
</head>
<body>
  <canvas id="gameCanvas"></canvas>
  <div id="hud">
    Score: <span id="score">0</span>
  </div>
  <script type="module" src="./game.js"></script>
</body>
</html>`,
      'game.js': `import { HawkesPlay } from '/public/hawkes-play.js';

const game = new HawkesPlay();

// Sky color
game.scene.setBackgroundColor(0.5, 0.7, 1, 1);

// Create player
game.scene.addEntity({
  name: 'player',
  type: 'sphere',
  position: [0, 2, 0],
  scale: 0.5,
  material: { color: [1, 0.8, 0.2] },
  physics: { mass: 1, restitution: 0.1 }
});

// Create platforms
const platforms = [
  { x: 0, z: 0, w: 8, h: 1 },
  { x: 6, z: 0, w: 4, h: 1 },
  { x: 12, z: 1, w: 4, h: 1 },
  { x: 18, z: 2, w: 6, h: 1 },
];

platforms.forEach((p, i) => {
  game.scene.addEntity({
    name: \`platform\${i}\`,
    type: 'box',
    position: [p.x, 0, p.z],
    scale: [p.w, 0.5, 2],
    material: { color: [0.3, 0.6, 0.3] },
    physics: { mass: 0 }
  });
});

// Create collectibles
for (let i = 0; i < 5; i++) {
  const x = i * 4 + 2;
  game.scene.addEntity({
    name: \`coin\${i}\`,
    type: 'sphere',
    position: [x, 3, 0],
    scale: 0.3,
    material: { color: [1, 1, 0], emissive: [0.5, 0.5, 0] },
    physics: { mass: 0 }
  });
}

// Game state
let score = 0;
const scoreEl = document.getElementById('score');

// Movement
const speed = 5;
const jumpForce = 150;

game.onUpdate((dt) => {
  const player = game.getEntity('player');
  const [x, y, z] = player.getPosition();

  // Horizontal movement
  if (game.input.isKeyDown('a')) player.move(-speed * dt, 0, 0);
  if (game.input.isKeyDown('d')) player.move(speed * dt, 0, 0);

  // Jump
  if (game.input.isKeyDown('space') && y < 2.5) {
    player.applyForce(0, jumpForce, 0);
  }

  // Collect coins
  for (let i = 0; i < 5; i++) {
    const coin = game.getEntity(\`coin\${i}\`);
    if (!coin) continue;
    const [cx, cy, cz] = coin.getPosition();
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2);
    if (dist < 1) {
      game.removeEntity(\`coin\${i}\`);
      score += 10;
      scoreEl.textContent = score;
    }
  }

  // Camera follows player
  game.scene.setCameraPosition(x, y + 5, z + 8);
  game.scene.setCameraTarget(x, y, z);
});

game.start();
`,
    },
  },
  {
    id: 'physics',
    name: 'Physics Sandbox',
    description: 'Experiment with physics and forces',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Physics Sandbox</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      font-family: Arial, sans-serif;
    }
    #gameCanvas {
      width: 100%;
      height: 100vh;
      display: block;
    }
    #hud {
      position: absolute;
      top: 20px;
      left: 20px;
      color: white;
      font-size: 18px;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
    }
  </style>
  <script src="https://cdn.babylonjs.com/babylon.js"></script>
  <script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>
  <script src="https://cdn.babylonjs.com/cannon.js"></script>
</head>
<body>
  <canvas id="gameCanvas"></canvas>
  <div id="hud">
    <div>Click to spawn boxes</div>
    <div>R - Reset</div>
  </div>
  <script type="module" src="./game.js"></script>
</body>
</html>`,
      'game.js': `import { HawkesPlay } from '/public/hawkes-play.js';

const game = new HawkesPlay();

// Sky color
game.scene.setBackgroundColor(0.3, 0.3, 0.4, 1);

// Create walls
game.scene.addEntity({
  name: 'leftWall',
  type: 'box',
  position: [-10, 5, 0],
  scale: [1, 10, 20],
  material: { color: [0.4, 0.4, 0.5] },
  physics: { mass: 0 }
});

game.scene.addEntity({
  name: 'rightWall',
  type: 'box',
  position: [10, 5, 0],
  scale: [1, 10, 20],
  material: { color: [0.4, 0.4, 0.5] },
  physics: { mass: 0 }
});

// Create ramp
game.scene.addEntity({
  name: 'ramp',
  type: 'box',
  position: [5, 2, 0],
  rotation: [0, 0, -0.5],
  scale: [8, 0.5, 4],
  material: { color: [0.5, 0.6, 0.5] },
  physics: { mass: 0 }
});

let boxCount = 0;

// Spawn box on click
game._scene.onPointerDown = () => {
  const x = (Math.random() - 0.5) * 8;
  const z = (Math.random() - 0.5) * 8;

  game.scene.addEntity({
    name: \`box\${boxCount++}\`,
    type: Math.random() > 0.5 ? 'box' : 'sphere',
    position: [x, 10, z],
    scale: 0.5 + Math.random() * 0.5,
    material: {
      color: [Math.random(), Math.random(), Math.random()]
    },
    physics: {
      mass: 1,
      restitution: 0.5,
      friction: 0.3
    }
  });
};

// Reset on R key
game.onUpdate(() => {
  if (game.input.isKeyDown('r')) {
    // Remove all spawned boxes
    for (let i = 0; i < boxCount; i++) {
      game.removeEntity(\`box\${i}\`);
    }
    boxCount = 0;
  }
});

game.start();
`,
    },
  },
];

export function getTemplate(id: string): GameTemplate | undefined {
  return GAME_TEMPLATES.find((t) => t.id === id);
}

export function listTemplates() {
  return GAME_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
}
