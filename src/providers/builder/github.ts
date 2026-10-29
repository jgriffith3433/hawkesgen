// GitHub mode for cloud Unity builds (docs/unity-cloudrun.md, "GitHub mode"): nothing comes from a checkout here.
// The container fetches the Unity source repo at one commit, the repos of its local file: packages at their branch,
// and the website repo's beta branch; it builds, then commits Game/v<n> and the loader to that branch and pushes it.
// Studio asks for it when J pushes a build-* tag (hawkesstudio src/tagbuild.ts). Never main: the push target is
// checked here and again in the container.

import type { RepoSpec } from './cloudrun.ts';
import { GenError } from '../../util.ts';

const bad = (message: string) => new GenError(message, { status: 400, kind: 'params' });

/** Branches a build never pushes to: live is J's typed DEPLOY through Studio. */
export const PROTECTED_BRANCHES = ['main', 'master', 'gh-pages', 'live', 'production'];
/** The branch a GitHub-mode build pushes to unless asked otherwise. */
export const DEFAULT_PUSH_BRANCH = 'beta';
/** The branch the local file: packages (hawkesgen, hawkesstudio) are fetched at unless asked otherwise. */
export const DEFAULT_PACKAGE_REF = 'main';

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9 _.\/-]{0,200}$/;

/** What a GitHub-mode build fetches and where it pushes. */
export type GitHubBuild = {
  /** The Unity source repo, "owner/name". */
  repo: string;
  /** The exact commit to build (a tag's commit). */
  commit: string;
  /** What asked for it (the tag, "build-2026-10-28"), for the commit message and the log. */
  ref: string | null;
  /** The website repo the build is committed to, "owner/name". */
  siteRepo: string;
  /** The branch of the website repo the build is pushed to (beta; never main). */
  branch: string;
  /** Branch (or commit) each local file: package repo is fetched at, by folder ("hawkesgen": "main"). */
  packages: Record<string, string>;
  /** The Library cache key family: beta (the default) or main. */
  cacheBranch: string;
  /**
   * The game's name in R2 when its builds live there, not in git (hawkesstudio docs/unity-builds-storage.md): the
   * container uploads Game/v<n> to builds/<builds>/v<n>/ and commits only the pages and Game/build.json. null: in git.
   */
  builds: string | null;
};

/** Where R2 builds go and are served from (settings.unityBuild.r2 overrides; the token is the job's secret r2-builds). */
export const R2_BUILDS = { account: 'f56b430f66b4e90148c6ae88cbb5a77c', bucket: 'hawkes-beta-sites', base: 'https://sites.hawkesgen.ai/builds' };

/** Checks and fills in the `github` param of unity.build; throws a plain error for anything off. */
export function githubBuildOf(raw: unknown, project: string, site?: string): GitHubBuild {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('github must be an object: { repo, commit, siteRepo, branch? }');
  const g = raw as Record<string, unknown>;
  const repo = String(g.repo ?? '').trim();
  const commit = String(g.commit ?? '').trim().toLowerCase();
  const siteRepo = String(g.siteRepo ?? '').trim();
  const branch = String(g.branch ?? DEFAULT_PUSH_BRANCH).trim();
  if (!SLUG_RE.test(repo)) throw bad(`github.repo must be "owner/name" (got "${repo}")`);
  if (!SHA_RE.test(commit)) throw bad(`github.commit must be the full commit sha, 40 hex characters (got "${commit}")`);
  if (!site) throw bad('a GitHub-mode build needs site (the website folder its build method writes)');
  if (!SLUG_RE.test(siteRepo)) throw bad(`github.siteRepo must be "owner/name" (got "${siteRepo}")`);
  if (!BRANCH_RE.test(branch) || branch.startsWith('refs/')) throw bad(`github.branch "${branch}" isn't a branch name`);
  if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) throw bad(`a build never pushes ${branch}: going live is J's typed DEPLOY through Studio`);
  if (siteRepo.toLowerCase() === repo.toLowerCase()) throw bad('github.siteRepo must be the website repo, not the source repo');
  if (!PATH_RE.test(project) || !PATH_RE.test(site)) throw bad('project and site must be plain relative folders');
  const packages: Record<string, string> = { hawkesgen: DEFAULT_PACKAGE_REF, hawkesstudio: DEFAULT_PACKAGE_REF };
  if (g.packages && typeof g.packages === 'object') {
    for (const [k, v] of Object.entries(g.packages as Record<string, unknown>)) {
      const ref = String(v ?? '').trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(k) || !(BRANCH_RE.test(ref) || SHA_RE.test(ref))) throw bad(`github.packages.${k} must be a branch or commit`);
      packages[k] = ref;
    }
  }
  const ref = g.ref ? String(g.ref).trim().slice(0, 120) : null;
  if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref)) throw bad(`github.ref "${ref}" has characters a ref can't`);
  const cacheBranch = g.cacheBranch === 'main' ? 'main' : 'beta';
  const builds = g.builds == null || g.builds === '' ? null : String(g.builds).trim();
  if (builds !== null && !/^[a-z0-9-]{1,40}$/.test(builds)) throw bad(`github.builds "${builds}" must be a game's short name (lowercase letters, digits, dashes)`);
  return { repo, commit, ref, siteRepo, branch, packages, cacheBranch, builds };
}

/**
 * The source repo as the container's fetch list: the project sits at Projects/<project>; the repo's root is the part
 * of the project path above `inside` (YoobaLand/YoobaLand is the folder YoobaLand inside the repo YoobaLand), fetched
 * sparse to that folder. The packages are not listed: the container reads them from the project's manifest.
 */
export function githubRepos(gh: GitHubBuild, project: string): RepoSpec[] {
  const parts = project.replace(/\\/g, '/').split('/').filter(Boolean);
  const top = parts[0];
  const inside = parts.slice(1).join('/');
  return [{ slug: gh.repo, top, commit: gh.commit, branch: null, sparse: inside ? [inside] : [] }];
}

/** The website as the container's checkout and push target. */
export function githubSite(gh: GitHubBuild, site: string) {
  const top = site.replace(/\\/g, '/').split('/').filter(Boolean)[0];
  return { slug: gh.siteRepo, top, branch: gh.branch };
}

/** The message of the commit the container pushes to the website's branch. */
export function buildCommitMessage(gh: GitHubBuild, project: string) {
  const short = gh.commit.slice(0, 7);
  return `Unity build: ${project} ${short}${gh.ref ? ` (${gh.ref})` : ''}\n\nBuilt by Hawkes Gen on Cloud Run from ${gh.repo}@${gh.commit}${gh.ref ? `, asked for by ${gh.ref}` : ''}.\nPushed to ${gh.branch} only; going live is J's DEPLOY through Hawkes Studio.`;
}
