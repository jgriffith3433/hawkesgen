// AI Assistant for game building - understands the Hawkes Play API and can generate code and assets

import * as claude from './providers/anthropic.ts';
import { submit, getJob, type JobSpec } from './jobs.ts';
import { quoteJobCredits, reserveJobCredits, chargeCredits } from './billing.ts';
import { GenError } from './util.ts';
import type { Client } from './auth.ts';
import { isGenAccountProject, isHouseProject, orgOfProject, orgSecretInfo } from './orgsecrets.ts';
import * as house from './houseai.ts';
import { getUserById } from './users.ts';
import { recordUsage } from './usage.ts';

const SYSTEM_PROMPT = `You are an AI assistant helping users build web games with Hawkes Play, a script layer over Babylon.js.

## Hawkes Play API Reference

### Game Setup
\`\`\`javascript
import { HawkesPlay } from '/public/hawkes-play.js';
const game = new HawkesPlay();
game.start();
\`\`\`

### Adding Entities
\`\`\`javascript
game.scene.addEntity({
  name: 'player',
  type: 'box', // 'box', 'sphere', 'cylinder', 'plane', 'ground'
  position: [x, y, z],
  rotation: [rx, ry, rz], // radians
  scale: [sx, sy, sz] or number,
  material: {
    color: [r, g, b], // 0-1 range
    emissive: [r, g, b],
    alpha: 0-1,
    texture: '/path/to/texture.png'
  },
  physics: {
    mass: 1, // 0 = static
    restitution: 0.3, // bounce
    friction: 0.5
  }
});
\`\`\`

### Entity Methods
\`\`\`javascript
const entity = game.getEntity('name');
entity.setPosition(x, y, z);
entity.move(dx, dy, dz); // relative movement
entity.rotate(dx, dy, dz); // radians
entity.applyForce(x, y, z); // requires physics
entity.setVelocity(x, y, z); // requires physics
const [x, y, z] = entity.getPosition();
\`\`\`

### Game Loop
\`\`\`javascript
game.onUpdate((deltaTime) => {
  // deltaTime is in seconds
  // Your game logic here
});
\`\`\`

### Input
\`\`\`javascript
if (game.input.isKeyDown('w')) { /* move forward */ }
if (game.input.isKeyDown('space')) { /* jump */ }
const { x, y } = game.input.getMousePosition();
if (game.input.isMouseButtonDown('left')) { /* fire */ }
\`\`\`

### Camera
\`\`\`javascript
game.scene.setCameraPosition(x, y, z);
game.scene.setCameraTarget(x, y, z);
\`\`\`

### Assets
\`\`\`javascript
// Load model
const meshes = await game.assets.loadModel('/models/character.glb', 'hero');

// Load texture
const texture = game.assets.loadTexture('/textures/wood.png', 'wood');
\`\`\`

## Your Role

1. **Answer questions** about the Hawkes Play API
2. **Write code** for game mechanics (movement, physics, gameplay)
3. **Suggest assets** that can be generated (textures, 3D models, sounds)
4. Be **concise** - users want quick answers
5. Always provide **working code examples**

When users ask to generate assets, suggest specific prompts for the Gen tools:
- Images/Textures: "Generate a seamless brick wall texture"
- 3D Models: "Generate a low-poly tree model"
- Audio: "Generate a jump sound effect"

Keep responses under 200 words unless explaining complex code.`;

export type AssistantMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AssistantResponse = {
  message: string;
  suggestedAssets?: Array<{
    type: 'image' | 'model' | 'audio';
    prompt: string;
    tool: string;
  }>;
  code?: string;
};

/** Who a legacy assistant call is for: the signed-in client, its project, and the Gen account that pays (if any). */
export type Caller = { client: Client; project: string; payerId: string | null };

type AskRequest = Parameters<typeof claude.ask>[0];

/**
 * One Claude call for a customer, on the same route as the other assistants (the AI editor: src/editor.ts). The account's
 * own key or subscription first; else, for a Gen app account, the house AI (src/houseai.ts), which it pays for in credits
 * (402 before the call when it can't, the charge after). The call always runs inside a customer's callScope, so the
 * studio's own Claude is never used: a call with no access of its own is refused (402), not run on ours.
 */
export async function customerAsk(who: Caller, req: AskRequest, what: string): Promise<{ text: string }> {
  const org = orgOfProject(who.project);
  const ownAi = Boolean(org && (orgSecretInfo(org, 'anthropic').set || orgSecretInfo(org, 'claude-subscription').set));
  const payer = who.payerId && isGenAccountProject(who.project) && !ownAi ? who.payerId : null;
  if (payer) house.checkCanPay(getUserById(payer)?.credits ?? 0);
  const r = await claude.callScope.run({ customer: true, org, house: isHouseProject(who.project) }, () => claude.ask(req));
  const onHouse = !['byok', 'subscription'].includes(r.billing);
  if (payer && onHouse) chargeCredits(payer, house.turnCredits(r.cost ?? 0), 'ai_turn', `Assistant: ${what}`.slice(0, 120));
  recordUsage({ client: who.client.name, project: who.project, ...claude.usageOf(r, `${onHouse ? 'house AI (Gen)' : 'own Claude'}: assistant ${what}`.slice(0, 200)) });
  return { text: r.text };
}

/** The legacy assistant's account gate: a Gen app account must be the one paying (its own user row), else refused. */
function requireCaller(who: Caller) {
  if (isGenAccountProject(who.project) && !who.payerId) throw new GenError('Sign in to your Gen account to use the assistant', { status: 403 });
}

/**
 * Process a user message and return an AI response
 */
export async function processMessage(
  who: Caller,
  gameContext: { gameName?: string; currentFile?: string; currentCode?: string },
  history: AssistantMessage[],
  newMessage: string
): Promise<AssistantResponse> {
  requireCaller(who);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Add context about the current game
  if (gameContext.gameName) {
    messages.push({
      role: 'user',
      content: `I'm working on a game called "${gameContext.gameName}".`
    });
    messages.push({
      role: 'assistant',
      content: `Great! I'll help you build "${gameContext.gameName}". What would you like to add?`
    });
  }

  // Add conversation history
  messages.push(...history);

  // Add the new message
  messages.push({ role: 'user', content: newMessage });

  try {
    // Convert messages to a single prompt string
    const prompt = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');

    const response = await customerAsk(who, {
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 500
    }, 'chat');

    const responseText = response.text;

    // Parse response for asset generation suggestions
    const suggestedAssets = extractAssetSuggestions(responseText);

    // Extract code blocks if any
    const code = extractCode(responseText);

    return {
      message: responseText,
      suggestedAssets,
      code
    };
  } catch (error: any) {
    // A refusal from the route itself (402 no credits, 503 house AI down, 402 no access) keeps its status.
    if (error instanceof GenError) throw error;
    throw new GenError(`AI assistant error: ${error.message}`, { status: 500 });
  }
}

/**
 * Generate an asset based on user request
 */
export async function generateAsset(
  client: Client,
  userId: string,
  type: 'image' | 'model' | 'audio' | 'texture',
  prompt: string,
  params: Record<string, any> = {}
): Promise<{ jobId: string; credits: number }> {
  // Map asset type to Gen tool
  const toolMap: Record<string, string> = {
    'image': 'image.generate',
    'texture': 'image.generate',
    'model': 'mesh.from-image',
    'audio': 'audio.sfx'
  };

  const tool = toolMap[type];
  if (!tool) {
    throw new GenError(`Unknown asset type: ${type}`, { status: 400 });
  }

  // Prepare tool params
  const toolParams: Record<string, any> = { prompt, ...params };

  if (type === 'texture') {
    toolParams.seamless = true;
  }

  // Quote the job
  const quote = quoteJobCredits(tool, toolParams, userId);

  // Submit job first to get job ID
  const job = submit(client, {
    project: userId,
    tool,
    params: toolParams,
    inputs: {},
    labels: { assistant: 'true', type }
  });

  // Reserve credits for the job
  const detail = `Generate ${type}: ${prompt.slice(0, 50)}`;
  reserveJobCredits(userId, job.id, quote.credits, detail);

  return {
    jobId: job.id,
    credits: quote.credits
  };
}

/**
 * Extract asset generation suggestions from AI response
 */
function extractAssetSuggestions(response: string): Array<{ type: 'image' | 'model' | 'audio'; prompt: string; tool: string }> {
  const suggestions: Array<{ type: 'image' | 'model' | 'audio'; prompt: string; tool: string }> = [];

  // Look for patterns like "Generate a [texture/model/sound] of X"
  const patterns = [
    /generate (?:a |an )?(seamless |low-poly |)?(texture|image|model|sound|sfx|music) (?:of |for )?(.+?)(?:\.|$)/gi,
    /create (?:a |an )?(seamless |low-poly |)?(texture|image|model|sound|sfx|music) (?:of |for )?(.+?)(?:\.|$)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const [, modifier, assetType, description] = match;
      const type = assetType.toLowerCase().includes('model') ? 'model' :
                   assetType.toLowerCase().includes('sound') || assetType.toLowerCase().includes('sfx') || assetType.toLowerCase().includes('music') ? 'audio' :
                   'image';

      const tool = type === 'image' ? 'image.generate' :
                   type === 'model' ? 'mesh.from-image' :
                   'audio.sfx';

      const prompt = `${modifier || ''}${description}`.trim();

      suggestions.push({ type, prompt, tool });
    }
  }

  return suggestions;
}

/**
 * Extract code blocks from response
 */
function extractCode(response: string): string | undefined {
  const codeBlockMatch = response.match(/```(?:javascript|js)?\n([\s\S]+?)\n```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return undefined;
}

/**
 * Get code suggestions for a specific context
 */
export async function getCodeSuggestions(
  who: Caller,
  context: {
    intent: string; // e.g., "add player movement", "create platformer controls"
    currentCode?: string;
  }
): Promise<string> {
  requireCaller(who);
  const promptText = context.currentCode
    ? `Given this game code:\n\`\`\`javascript\n${context.currentCode}\n\`\`\`\n\nHelp me ${context.intent}. Provide only the code to add, with comments.`
    : `Show me how to ${context.intent} in Hawkes Play. Provide a complete code example.`;

  const response = await customerAsk(who, {
    system: SYSTEM_PROMPT,
    prompt: promptText,
    maxTokens: 400
  }, 'code');

  const code = extractCode(response.text);
  return code || response.text;
}
