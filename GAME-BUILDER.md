# Hawkes Play - Game Builder Platform

A subscription-based collaborative web game builder with AI assistance, built on top of Hawkes Gen.

## Architecture

### Frontend

#### Landing Page (`/home` → `landing.html`)
- Hero section with platform pitch
- Feature showcase (6 key features)
- How it works (4-step process)
- Subscription pricing (Free, Creator $19/mo, Studio $49/mo)
- Call-to-action sections

#### Game Editor (`/app` → `game-editor.html`)
- **Games List View**: Grid of user's games with "New Game" card
- **Editor View**:
  - File tree sidebar (left)
  - Monaco code editor (center) with Hawkes Play API autocomplete
  - Live preview iframe (right)
  - AI assistant chat panel (bottom, toggleable)
  - Top bar with game name, credits, settings
- Real-time auto-save with 1s debounce
- Template selection on game creation

#### Game Player (`/play`)
- Loads games by ID, subdomain, or release
- Executes game files in isolated environment
- Error handling with detailed messages
- Loading states

### Backend APIs

#### Games (`/v1/games/*`)
- `POST /v1/games` - Create new game
- `GET /v1/games` - List user's games
- `GET /v1/games/:id` - Get game details
- `PATCH /v1/games/:id` - Update game (name, description, publish)
- `DELETE /v1/games/:id` - Delete game
- `GET /v1/games/:id/members` - List members
- `POST /v1/games/:id/members` - Invite member
- `DELETE /v1/games/:id/members/:userId` - Remove member
- `GET /v1/games/:id/files` - List files
- `POST /v1/games/:id/files` - Create/update file
- `GET /v1/games/:id/files/:path` - Get file
- `DELETE /v1/games/:id/files/:path` - Delete file
- `GET /v1/games/:id/releases` - List releases
- `POST /v1/games/:id/releases` - Create release

#### Subscriptions (`/v1/subscriptions/*`)
- `GET /v1/subscriptions/plans` - List available plans
- `POST /v1/subscriptions/plans` - Create plan (owner only)
- `GET /v1/subscriptions/me` - Get user's subscription

#### AI Assistant (`/v1/assistant/*`)
- `POST /v1/assistant/chat` - Chat with AI about game development
- `POST /v1/assistant/generate` - Generate assets (images, models, audio)
- `POST /v1/assistant/code-suggestions` - Get code suggestions for specific intents

#### Templates (`/v1/templates/*`)
- `GET /v1/templates` - List starter templates
- `GET /v1/templates/:id` - Get template files

#### Play (`/v1/play/*`)
- `GET /v1/play/:subdomain` - Load published game by subdomain
- `GET /v1/releases/:id` - Load specific release

### Database Schema

#### `subscription_plans`
- Subscription tiers (Free, Creator, Studio)
- Monthly credits allocation
- Game and member limits
- Stripe price ID integration

#### `user_subscriptions`
- User's active subscription
- Period start/end dates
- Stripe subscription ID
- Cancellation status

#### `games`
- Game metadata (name, slug, description)
- Owner user ID
- Published status and subdomain
- Created/updated timestamps

#### `game_members`
- User memberships in games
- Role: owner, editor, or viewer
- Invitation tracking

#### `game_files`
- File path and content
- Last updated by user
- Created/updated timestamps

#### `game_releases`
- Version number and notes
- Snapshot of all files at release time
- Released by user ID

### Hawkes Play Runtime

JavaScript library (`hawkes-play.js`) that provides a simple API over Babylon.js:

**Core Classes:**
- `HawkesPlay` - Main game instance
- `SceneAPI` - Scene management (`game.scene`)
- `Entity` - Game objects with physics, materials, transforms
- `InputManager` - Keyboard/mouse input (`game.input`)
- `AssetManager` - Load models and textures (`game.assets`)

**Key Features:**
- Entity system (box, sphere, cylinder, plane, ground)
- Physics with Cannon.js (mass, restitution, friction)
- Material system (colors, emissive, textures)
- Input handling (keyboard, mouse)
- Camera control
- Update loop with delta time
- Asset loading (GLB models, textures)

**Complete API reference**: `hawkes-play-api.md`

### AI Assistant

Powered by Claude (via `anthropic.ts`), the assistant:

1. **Answers questions** about the Hawkes Play API
2. **Writes code** for game mechanics (movement, physics, gameplay)
3. **Generates assets** via Gen tools (textures, models, sounds)
4. **Provides context-aware help** based on current game and file

**Features:**
- Conversation history (last 10 messages)
- Code extraction and one-click insertion into editor
- Asset suggestion detection with generation UI
- Code snippets library (WASD movement, jump, camera, physics)

### Starter Templates

Four templates to get started quickly:

1. **Blank** - Empty canvas with just the runtime
2. **FPS** - First-person controller with WASD and jump
3. **Platformer** - Side-scrolling with collectibles
4. **Physics Sandbox** - Click to spawn objects with physics

## Setup & Usage

### Initial Setup

1. **Database Migrations**: Automatically run on first start
2. **Seed Subscription Plans**:
   ```bash
   node bin/seed-plans.mjs
   ```
3. **Configure Stripe** (optional):
   - Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
   - Or use `/v1/billing/config` API to set keys at runtime
4. **Start the service**:
   ```bash
   npm start
   # or
   auto-start.bat
   ```

### User Flow

1. **Sign Up**: User creates account at `/app`, gets 50 free credits
2. **Choose Plan**: Upgrade to Creator or Studio for monthly credits
3. **Create Game**: Pick a template, get starter files
4. **Build**: Edit code, use AI assistant, generate assets
5. **Collaborate**: Invite friends (up to plan limit)
6. **Publish**: Set subdomain, publish, share URL

### Credit System

- **Credits purchased**: One-time credit packs (existing system)
- **Monthly allocation**: Subscription plans include credits/month
- **Usage**: Credits consumed for AI asset generation only
- **Runtime/editor**: Free to use (no credits)

### Subscription Plans

| Plan | Price | Credits/mo | Games | Members | Features |
|------|-------|------------|-------|---------|----------|
| **Free** | $0 | 50 (signup) | 1 | 2 | All templates, AI assistant, Live preview |
| **Creator** | $19 | 500 | 5 | 4 | + Custom subdomain, Priority support, Commercial use |
| **Studio** | $49 | 1500 | Unlimited | Unlimited | + Priority GPU, Advanced tools, Custom domain |

### Routes Summary

| Route | Description |
|-------|-------------|
| `/` | Landing page (game builder pitch) |
| `/home` | Landing page |
| `/app` | Game editor / games list |
| `/play` | Game player (dev mode) |
| `/play?game=:id` | Play game in development |
| `/play?subdomain=:name` | Play published game |
| `/play?release=:id` | Play specific release |

## Development

### TypeScript Structure

```
src/
  api.ts              # HTTP routes
  games.ts            # Games CRUD
  billing.ts          # Subscriptions + credits
  assistant.ts        # AI chat and asset generation
  templates.ts        # Starter templates
  db.ts               # Database schema + migrations
  
dashboard/public/
  landing.html        # Landing page
  game-editor.html    # Editor UI
  game-editor.js      # Editor logic
  player.html         # Game player
  hawkes-play.js      # Runtime library
  hawkes-play-api.md  # API reference
```

### Adding Features

**New Template:**
1. Add to `src/templates.ts` `GAME_TEMPLATES`
2. Include `index.html`, `game.js` files
3. Template shows up in "New Game" modal

**New AI Capability:**
1. Update `SYSTEM_PROMPT` in `src/assistant.ts`
2. Add extraction logic if needed (e.g., `extractAssetSuggestions`)
3. Update frontend to handle new response types

**New Runtime Feature:**
1. Add to `hawkes-play.js` classes
2. Document in `hawkes-play-api.md`
3. Add Monaco autocomplete snippets in `game-editor.js`

## Integration with Hawkes Gen

The game builder **extends** Hawkes Gen:

- Uses existing Gen tools for asset generation
- Credits system integrated (one-time + monthly)
- Hawkes Play games use Gen-generated assets
- Users can access full Creator Studio if needed

**User project scope:**
- Each user gets `project: userId` for their Gen jobs
- Assets generated in games are scoped to user
- Can use Gen library for asset reuse

## Future Enhancements

- [ ] Real-time collaboration via WebSockets
- [ ] Version control (git integration)
- [ ] Marketplace for game templates and assets
- [ ] Mobile touch controls in runtime
- [ ] Multiplayer networking helpers
- [ ] Analytics dashboard for published games
- [ ] Custom domains for Studio plan
- [ ] GitHub integration for backups
- [ ] Video tutorials and guided tours

## Testing

```bash
# Type check
npm run typecheck

# Test workflow tools and presets
npm test

# Start local dev server
npm start

# Access:
# http://localhost:8790/home   - Landing
# http://localhost:8790/app    - Editor
# http://localhost:8790/play   - Player
```

## Deployment

Same as Hawkes Gen - push to `main` deploys to cloud:

1. CI runs (typecheck + tests)
2. Server pulls and restarts
3. Database migrations run automatically
4. Subscription plans need to be seeded once

**Environment Variables:**
- Existing Gen variables
- Optional: Stripe keys for subscriptions

## Summary

The game builder transforms Hawkes Gen from a tool-focused platform into a complete collaborative game development experience. Users build games using the Hawkes Play runtime, get AI assistance, generate assets, collaborate with friends, and publish instantly—all with subscription-based monthly credits.
