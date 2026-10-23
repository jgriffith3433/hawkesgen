#!/usr/bin/env node
// Seed subscription plans into the database

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', '.data', 'hawkesgen.db');

console.log('Seeding subscription plans...');
console.log('Database:', dbPath);

const db = new DatabaseSync(dbPath);

const plans = [
  {
    id: 'free',
    name: 'Free',
    priceCents: 0,
    creditsPerMonth: 50,
    maxGames: 1,
    maxMembersPerGame: 2,
    stripePriceId: null
  },
  {
    id: 'creator',
    name: 'Creator',
    priceCents: 1900,
    creditsPerMonth: 500,
    maxGames: 5,
    maxMembersPerGame: 4,
    stripePriceId: null // Set this after creating in Stripe
  },
  {
    id: 'studio',
    name: 'Studio',
    priceCents: 4900,
    creditsPerMonth: 1500,
    maxGames: 999,
    maxMembersPerGame: 999,
    stripePriceId: null
  }
];

try {
  for (const plan of plans) {
    // Check if plan exists
    const existing = db.prepare('SELECT id FROM subscription_plans WHERE id = ?').get(plan.id);

    if (existing) {
      console.log(`Plan "${plan.name}" already exists, skipping.`);
      continue;
    }

    // Insert plan
    db.prepare(`
      INSERT INTO subscription_plans (id, name, price_cents, credits_per_month, max_games, max_members_per_game, stripe_price_id, active, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      plan.id,
      plan.name,
      plan.priceCents,
      plan.creditsPerMonth,
      plan.maxGames,
      plan.maxMembersPerGame,
      plan.stripePriceId,
      Date.now()
    );

    console.log(`✓ Created plan: ${plan.name} ($${plan.priceCents / 100}/mo, ${plan.creditsPerMonth} credits/month)`);
  }

  console.log('\nSubscription plans seeded successfully!');
} catch (error) {
  console.error('Error seeding plans:', error);
  process.exit(1);
}

db.close();
