// Collaborative web game projects: games, members, files, and releases.

import { db, parseRow, J } from './db.ts';
import { id, GenError } from './util.ts';

export type Game = {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string;
  published: number;
  publishedAt: number | null;
  subdomain: string | null;
  created: number;
  updated: number;
};

export type GameMember = {
  id: string;
  gameId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  invitedBy: string | null;
  joined: number;
};

export type GameFile = {
  id: string;
  gameId: string;
  path: string;
  content: string;
  updatedBy: string;
  created: number;
  updated: number;
};

export type GameRelease = {
  id: string;
  gameId: string;
  version: string;
  notes: string;
  files: Record<string, string>; // path -> content snapshot
  releasedBy: string;
  created: number;
};

export function createGame(userId: string, data: { name: string; slug: string; description?: string }): Game {
  const now = Date.now();
  const gameId = id('game', 8);
  const slug = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 50);

  // Check if slug is unique for this user
  const existing = db.prepare('SELECT id FROM games WHERE user_id = ? AND slug = ?').get(userId, slug);
  if (existing) {
    throw new GenError(`You already have a game with slug "${slug}"`, { status: 409 });
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO games (id, user_id, slug, name, description, published, published_at, subdomain, created, updated)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
    ).run(gameId, userId, slug, data.name, data.description ?? '', now, now);

    // Add the creator as owner
    const memberId = id('member', 8);
    db.prepare(
      `INSERT INTO game_members (id, game_id, user_id, role, invited_by, joined)
       VALUES (?, ?, ?, 'owner', NULL, ?)`,
    ).run(memberId, gameId, userId, now);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return getGame(gameId)!;
}

export function getGame(gameId: string): Game | null {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as any;
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    published: row.published,
    publishedAt: row.published_at,
    subdomain: row.subdomain,
    created: row.created,
    updated: row.updated,
  };
}

export function getGameBySubdomain(subdomain: string): Game | null {
  const row = db.prepare('SELECT * FROM games WHERE subdomain = ?').get(subdomain) as any;
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    published: row.published,
    publishedAt: row.published_at,
    subdomain: row.subdomain,
    created: row.created,
    updated: row.updated,
  };
}

export function listUserGames(userId: string, opts: { limit?: number; offset?: number } = {}): { items: Game[]; total: number } {
  const limit = Math.min(100, opts.limit ?? 50);
  const offset = opts.offset ?? 0;

  const rows = db.prepare(
    `SELECT g.* FROM games g
     INNER JOIN game_members m ON m.game_id = g.id
     WHERE m.user_id = ?
     ORDER BY g.updated DESC
     LIMIT ? OFFSET ?`,
  ).all(userId, limit, offset) as any[];

  const total = (db.prepare(
    `SELECT COUNT(*) as count FROM games g
     INNER JOIN game_members m ON m.game_id = g.id
     WHERE m.user_id = ?`,
  ).get(userId) as any).count;

  return {
    items: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      published: row.published,
      publishedAt: row.published_at,
      subdomain: row.subdomain,
      created: row.created,
      updated: row.updated,
    })),
    total,
  };
}

export function updateGame(
  gameId: string,
  updates: Partial<Pick<Game, 'name' | 'description' | 'published' | 'subdomain'>>,
): Game {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.published !== undefined) {
    fields.push('published = ?');
    values.push(updates.published);
    if (updates.published) {
      fields.push('published_at = ?');
      values.push(Date.now());
    }
  }
  if (updates.subdomain !== undefined) {
    // Check subdomain availability
    if (updates.subdomain) {
      const existing = db.prepare('SELECT id FROM games WHERE subdomain = ? AND id != ?').get(updates.subdomain, gameId);
      if (existing) {
        throw new GenError(`Subdomain "${updates.subdomain}" is already taken`, { status: 409 });
      }
    }
    fields.push('subdomain = ?');
    values.push(updates.subdomain);
  }

  if (!fields.length) return getGame(gameId)!;

  fields.push('updated = ?');
  values.push(Date.now());
  values.push(gameId);

  db.prepare(`UPDATE games SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getGame(gameId)!;
}

export function deleteGame(gameId: string): void {
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

// ---------------------------------------------------------------- Members

export function addGameMember(
  gameId: string,
  userId: string,
  role: 'editor' | 'viewer',
  invitedBy: string,
): GameMember {
  const existing = db.prepare('SELECT id FROM game_members WHERE game_id = ? AND user_id = ?').get(gameId, userId);
  if (existing) {
    throw new GenError('User is already a member of this game', { status: 409 });
  }

  const memberId = id('member', 8);
  const now = Date.now();
  db.prepare(
    `INSERT INTO game_members (id, game_id, user_id, role, invited_by, joined)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(memberId, gameId, userId, role, invitedBy, now);

  return {
    id: memberId,
    gameId,
    userId,
    role,
    invitedBy,
    joined: now,
  };
}

export function listGameMembers(gameId: string): GameMember[] {
  const rows = db.prepare(
    'SELECT * FROM game_members WHERE game_id = ? ORDER BY joined',
  ).all(gameId) as any[];

  return rows.map((row) => ({
    id: row.id,
    gameId: row.game_id,
    userId: row.user_id,
    role: row.role,
    invitedBy: row.invited_by,
    joined: row.joined,
  }));
}

export function removeGameMember(gameId: string, userId: string): void {
  db.prepare('DELETE FROM game_members WHERE game_id = ? AND user_id = ?').run(gameId, userId);
}

export function canAccessGame(gameId: string, userId: string): boolean {
  const member = db.prepare('SELECT role FROM game_members WHERE game_id = ? AND user_id = ?').get(gameId, userId) as any;
  return !!member;
}

export function canEditGame(gameId: string, userId: string): boolean {
  const member = db.prepare('SELECT role FROM game_members WHERE game_id = ? AND user_id = ?').get(gameId, userId) as any;
  return member && (member.role === 'owner' || member.role === 'editor');
}

export function isGameOwner(gameId: string, userId: string): boolean {
  const member = db.prepare('SELECT role FROM game_members WHERE game_id = ? AND user_id = ?').get(gameId, userId) as any;
  return member && member.role === 'owner';
}

// ---------------------------------------------------------------- Files

export function saveGameFile(gameId: string, path: string, content: string, userId: string): GameFile {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM game_files WHERE game_id = ? AND path = ?').get(gameId, path) as any;

  if (existing) {
    db.prepare(
      'UPDATE game_files SET content = ?, updated_by = ?, updated = ? WHERE id = ?',
    ).run(content, userId, now, existing.id);
    db.prepare('UPDATE games SET updated = ? WHERE id = ?').run(now, gameId);
    return getGameFile(gameId, path)!;
  } else {
    const fileId = id('file', 8);
    db.prepare(
      `INSERT INTO game_files (id, game_id, path, content, updated_by, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, gameId, path, content, userId, now, now);
    db.prepare('UPDATE games SET updated = ? WHERE id = ?').run(now, gameId);
    return {
      id: fileId,
      gameId,
      path,
      content,
      updatedBy: userId,
      created: now,
      updated: now,
    };
  }
}

export function getGameFile(gameId: string, path: string): GameFile | null {
  const row = db.prepare('SELECT * FROM game_files WHERE game_id = ? AND path = ?').get(gameId, path) as any;
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    path: row.path,
    content: row.content,
    updatedBy: row.updated_by,
    created: row.created,
    updated: row.updated,
  };
}

export function listGameFiles(gameId: string): GameFile[] {
  const rows = db.prepare('SELECT * FROM game_files WHERE game_id = ? ORDER BY path').all(gameId) as any[];
  return rows.map((row) => ({
    id: row.id,
    gameId: row.game_id,
    path: row.path,
    content: row.content,
    updatedBy: row.updated_by,
    created: row.created,
    updated: row.updated,
  }));
}

export function deleteGameFile(gameId: string, path: string): void {
  db.prepare('DELETE FROM game_files WHERE game_id = ? AND path = ?').run(gameId, path);
  db.prepare('UPDATE games SET updated = ? WHERE id = ?').run(Date.now(), gameId);
}

// ---------------------------------------------------------------- Releases

export function createGameRelease(
  gameId: string,
  version: string,
  notes: string,
  userId: string,
): GameRelease {
  const files = listGameFiles(gameId);
  const filesSnapshot: Record<string, string> = {};
  for (const file of files) {
    filesSnapshot[file.path] = file.content;
  }

  const releaseId = id('release', 8);
  const now = Date.now();
  db.prepare(
    `INSERT INTO game_releases (id, game_id, version, notes, files, released_by, created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(releaseId, gameId, version, notes, J(filesSnapshot), userId, now);

  return {
    id: releaseId,
    gameId,
    version,
    notes,
    files: filesSnapshot,
    releasedBy: userId,
    created: now,
  };
}

export function listGameReleases(gameId: string, opts: { limit?: number; offset?: number } = {}): { items: GameRelease[]; total: number } {
  const limit = Math.min(100, opts.limit ?? 20);
  const offset = opts.offset ?? 0;

  const rows = db.prepare(
    'SELECT * FROM game_releases WHERE game_id = ? ORDER BY created DESC LIMIT ? OFFSET ?',
  ).all(gameId, limit, offset) as any[];

  const total = (db.prepare('SELECT COUNT(*) as count FROM game_releases WHERE game_id = ?').get(gameId) as any).count;

  return {
    items: rows.map((row) => parseRow<GameRelease>(row, ['files'])),
    total,
  };
}

export function getGameRelease(releaseId: string): GameRelease | null {
  const row = db.prepare('SELECT * FROM game_releases WHERE id = ?').get(releaseId) as any;
  if (!row) return null;
  return parseRow<GameRelease>(row, ['files']);
}
