# GitHub mode of the Unity cloud build (sourced by entrypoint.sh; docs/unity-cloudrun.md, "GitHub mode").
#
# The spec's .github block (src/providers/builder/github.ts) says: the website repo and the branch the build is pushed
# to (beta, never main), the branch each local file: package repo is fetched at, and the commit message. The source
# repo itself comes through the spec's .repos like any cloud build.
#
# Needs from the caller: P (the projects folder), WORK, S (spec.json), AUTH (the GitHub auth header line, never
# printed), and the functions j, log and die. HAWKES_GIT_BASE replaces https://github.com (the tests use local repos).

GIT_BASE="${HAWKES_GIT_BASE:-https://github.com}"
GH_HEADER_KEY="http.https://github.com/.extraheader"
GH_AUTHOR=(-c "user.name=Hawkes Gen" -c "user.email=gen@hawkesgen.ai")
PACKAGES_JSON='{}'
PUSHED_JSON=null

gh_url() { printf '%s/%s.git' "$GIT_BASE" "$1"; }
gh_auth_on() { git config "$GH_HEADER_KEY" "$AUTH"; }
gh_auth_off() { git config --unset-all "$GH_HEADER_KEY" >/dev/null 2>&1 || true; }

# A build never pushes these: live is J's typed DEPLOY through Hawkes Studio. Checked here as well as in Gen.
gh_protected() { case "${1,,}" in main|master|gh-pages|live|production|"") return 0;; *) return 1;; esac; }

# fetch_repo <slug> <top> <commit-or-branch> [sparse folder...]: Projects/<top> at exactly that, LFS files checked out.
fetch_repo() {
  local slug="$1" top="$2" commit="$3"; shift 3
  local dir="$P/$top"
  mkdir -p "$dir"
  ( cd "$dir" || exit 1
    [ -d .git ] || git init -q
    git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "$(gh_url "$slug")" || git remote add origin "$(gh_url "$slug")"
    gh_auth_on   # also used by Git LFS
    # Only the folders the build needs (a package inside hawkesgen, the project inside YoobaLand): non-cone patterns.
    if [ "$#" -gt 0 ]; then
      git config core.sparseCheckout true
      mkdir -p .git/info && printf '/%s/\n' "$@" > .git/info/sparse-checkout
    else
      git config core.sparseCheckout false
    fi
    git fetch -q --depth 1 --filter=blob:none origin "$commit" || exit 2
    git checkout -q -f --detach FETCH_HEAD || exit 3
    # Submodules (a shared package, art in its own repo), while the token is still on: the build has the whole project
    # (2026-10-31 review). The token must reach those repos too; one it can't is said and the build carries on.
    if [ -f .gitmodules ]; then
      git submodule update --init --recursive --depth 1 -q 2>"$WORK/submodules.log" || log "some submodules couldn't be fetched (the GitHub token must reach their repos): $(tail -n 2 "$WORK/submodules.log" | tr '\n' ' ')"
    fi
    # Keep a persistent Library (VM mode) and Unity's own folders; drop anything else left from an older build.
    git clean -q -fd -e Library -e Temp -e Logs -e UserSettings >/dev/null 2>&1
    gh_auth_off
    rm -rf .git/lfs/objects   # LFS files are in the working tree now; their second copy only costs memory
  )
}

# The repos of the project's local file: packages (file:C:/Projects/<repo>/<path> in Packages/manifest.json), each at
# the branch the spec names (main by default), sparse to the package folders. The project's own repo is skipped.
github_packages() {
  local proj="$1" top="$2" owner manifest repo ref sha
  owner=$(j .github.owner)
  manifest="$proj/Packages/manifest.json"
  [ -f "$manifest" ] || return 0
  jq -r '.dependencies // {} | to_entries[] | .value | select(type == "string")
    | select(test("^file:[A-Za-z]:/Projects/[^/]+/.")) | sub("^file:[A-Za-z]:/Projects/"; "")' "$manifest" > "$WORK/packages.txt" \
    || die source "Packages/manifest.json isn't JSON"
  for repo in $(cut -d/ -f1 "$WORK/packages.txt" | sort -u); do
    [ "$repo" = "$top" ] && continue
    ref=$(jq -r --arg r "$repo" '.github.packages[$r] // "HEAD"' "$S")
    mapfile -t sparse < <(grep "^$repo/" "$WORK/packages.txt" | cut -d/ -f2- | sed 's#/*$##' | sort -u)
    log "fetching package repo $owner/$repo at $ref: ${sparse[*]}"
    fetch_repo "$owner/$repo" "$repo" "$ref" "${sparse[@]}" || die source "couldn't fetch the package repo $owner/$repo at $ref (can the GitHub token read it?)"
    sha=$(git -C "$P/$repo" rev-parse HEAD)
    PACKAGES_JSON=$(jq -c --arg r "$repo" --arg s "$sha" '. + {($r): $s}' <<<"$PACKAGES_JSON")
  done
}

# The website repo's push branch (made from its default branch when it doesn't exist yet), checked out sparse: old
# Game/v<n> folders stay on GitHub, each with a stub here so the deploy method still sees the folder.
github_site() {
  local slug top branch site sub game d
  slug=$(j .github.site.slug); top=$(j .github.site.top); branch=$(j .github.site.branch); site="$1"
  gh_protected "$branch" && die config "a build never pushes '${branch:-<none>}': going live is J's DEPLOY through Hawkes Studio"
  sub="${site#"$top"}"; sub="${sub#/}"
  game="${sub:+$sub/}Game"
  SITE_REPO_DIR="$P/$top"
  rm -rf "$SITE_REPO_DIR"; mkdir -p "$SITE_REPO_DIR"
  log "checking out $slug $branch (old Game/v<n> left on GitHub)"
  ( cd "$SITE_REPO_DIR" || exit 1
    git init -q
    git remote add origin "$(gh_url "$slug")"
    gh_auth_on
    git config core.sparseCheckout true
    printf '/*\n!/%s/v[1-9]*/\n' "$game" > .git/info/sparse-checkout
    if git fetch -q --depth 1 --filter=blob:none origin "refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
      git checkout -q -B "$branch" "origin/$branch" || exit 3
    else
      git fetch -q --depth 1 --filter=blob:none origin HEAD || exit 2
      git checkout -q -B "$branch" FETCH_HEAD || exit 3
      echo "new" > .git/hawkes-new-branch
    fi
    gh_auth_off
    for d in $(git ls-tree -d --name-only HEAD "$game/" 2>/dev/null | grep -E '/v[1-9][0-9]*$'); do
      mkdir -p "$d"
      echo "Hawkes Gen cloud build: this folder's files stay on GitHub ($branch); the deploy method only needs to see it." > "$d/.hawkes-stub"
    done
    printf '.hawkes-stub\n' >> .git/info/exclude
  ) || die source "couldn't check out $slug $branch (can the GitHub token read it?)"
  [ -f "$SITE_REPO_DIR/.git/hawkes-new-branch" ] && log "$slug has no $branch yet: it starts from the default branch"
  SITE_BEFORE=$(git -C "$SITE_REPO_DIR" rev-parse HEAD)
}

# Builds in R2, not git (hawkesstudio docs/unity-builds-storage.md): when the spec's .github.builds names the game and
# the job has R2_BUILDS_TOKEN (Secret Manager r2-builds), each new Game/v<n> the build made is uploaded to
# builds/<game>/v<n>/ (Brotli .unityweb stored with Content-Encoding: br, so browsers decompress it), left out of the
# commit (a stub stands in, as for the old ones), the pages in Game/ point at its address, Game/build.json names it, and
# old versions are pruned (kept: this one, the ones beta's and main's build.json name, and the 2 newest others).
R2_STUB=".hawkes-r2"
# The R2 calls go through r2.mjs (signed with Node's crypto: the image's curl 7.81 signs S3 uploads wrongly).
r2() { R2_ACCOUNT="$(j .github.builds.account)" R2_BUCKET="$(j .github.builds.bucket)" node /hawkes/r2.mjs "$@"; }

github_r2_builds() {
  local site="$1" top sub game_rel gdir r2game base d ver f
  r2game=$(j .github.builds.game); base=$(j .github.builds.base)
  [ -n "$r2game" ] || return 0
  [ -n "${R2_BUILDS_TOKEN:-}" ] || die config "the spec sends this build to R2 but the job has no R2_BUILDS_TOKEN (Secret Manager r2-builds)"
  top=$(j .github.site.top); sub="${site#"$top"}"; sub="${sub#/}"
  game_rel="${sub:+$sub/}Game"; gdir="$SITE_REPO_DIR/$game_rel"
  R2_NEW=()
  for d in "$gdir"/v[1-9]*/; do
    d="${d%/}"; [ -d "$d" ] || continue
    [ -f "$d/.hawkes-stub" ] || [ -f "$d/$R2_STUB" ] && continue
    ver=$(basename "$d")
    log "uploading $game_rel/$ver to R2 builds/$r2game/$ver"
    r2 putdir "$d" "builds/$r2game/$ver/" 2>"$WORK/r2.err" || die push "couldn't upload $ver to R2: $(tail -1 "$WORK/r2.err" | cut -c1-300)"
    # Out of git: the folder becomes a stub the commit ignores (.git/info/exclude), the pages point at R2.
    find "$d" -mindepth 1 -delete
    echo "Hawkes Gen cloud build: this version is in R2 at $base/$r2game/$ver/" > "$d/$R2_STUB"
    R2_NEW+=("$ver")
    while IFS= read -r -d '' f; do
      # Literal paths ("v181/hawkes-sound.js") point at R2; a page that builds its paths at run time puts
      # window.HAWKES_BUILD_BASE in front of its version (one line after <head>, kept current here).
      sed -i -E "s#([\"'(=])$ver/#\1$base/$r2game/$ver/#g; /window\.HAWKES_BUILD_BASE *=/d" "$f"
      if [[ "$f" == *.html ]]; then sed -i -E "0,/<head[^>]*>/s##&\n  <script>window.HAWKES_BUILD_BASE = \"$base/$r2game/\";</script>#" "$f"; fi
    done < <(find "$gdir" -maxdepth 1 -type f \( -name '*.html' -o -name '*.js' \) -print0)
    jq -n --arg v "${ver#v}" --arg b "$base/$r2game/$ver/" '{ version: ($v | tonumber), base: $b }' > "$gdir/build.json"
  done
  printf '%s\n' "$R2_STUB" >> "$SITE_REPO_DIR/.git/info/exclude"
  [ "${#R2_NEW[@]}" -gt 0 ] || { log "no new Game/v<n> to upload"; return 0; }
  r2_prune "$r2game" "$game_rel"
}

# Keeps builds/<game>/ small: this build's versions, the ones the website's beta and main build.json name, and the 2
# newest others (a rollback target); the rest are deleted.
r2_prune() {
  local r2game="$1" game_rel="$2" all keep v br n=0 i
  mapfile -t all < <(r2 versions "builds/$r2game/" 2>/dev/null | sort -t v -k2 -n)
  keep=" ${R2_NEW[*]} "
  for br in beta main; do
    v=$( cd "$SITE_REPO_DIR" && gh_auth_on && git fetch -q --depth 1 --filter=blob:none origin "refs/heads/$br" 2>/dev/null \
      && git show "FETCH_HEAD:$game_rel/build.json" 2>/dev/null | jq -r '"v\(.version)"' 2>/dev/null; gh_auth_off )
    [ -n "$v" ] && [ "$v" != "vnull" ] && keep+="$v "
  done
  for ((i = ${#all[@]} - 1; i >= 0; i--)); do
    v="${all[$i]}"
    [[ "$keep" == *" $v "* ]] && continue
    if [ "$n" -lt 2 ]; then keep+="$v "; n=$((n + 1)); continue; fi
    log "pruning R2 builds/$r2game/$v"
    r2 rmprefix "builds/$r2game/$v/" >/dev/null 2>&1 || log "couldn't prune builds/$r2game/$v (next build tries again)"
  done
  log "R2 builds/$r2game keeps:$keep"
}

# Commits what the build changed in the website (deleted.txt: paths under the site folder; a stub gone = its whole
# Game/v<n>) and pushes it to the branch. A branch that moved meanwhile gets the build on top of it (3 tries).
github_publish() {
  local slug top branch site sub rel dir try source files msg
  slug=$(j .github.site.slug); top=$(j .github.site.top); branch=$(j .github.site.branch); site="$1"; source="$2"
  gh_protected "$branch" && die config "a build never pushes '${branch:-<none>}'"
  sub="${site#"$top"}"; sub="${sub#/}"
  cd "$SITE_REPO_DIR" || die push "no website checkout"
  git add -A --sparse -- . || die push "git add failed"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    rel="${sub:+$sub/}$rel"
    if [[ "$rel" == */.hawkes-stub ]]; then
      dir="${rel%/.hawkes-stub}"
      git rm -r -q --cached --sparse --ignore-unmatch -- "$dir" || die push "couldn't remove $dir"
    fi
  done < "$WORK/deleted.txt"
  if git diff --cached --quiet; then
    log "the build changed nothing in $slug $branch: nothing to push"
    cd "$P" || true
    return 0
  fi
  files=$(git diff --cached --name-only | wc -l)
  msg="$WORK/commit-message.txt"
  j .github.message > "$msg"
  [ -s "$msg" ] || echo "Unity build ${source:0:7}" > "$msg"
  git "${GH_AUTHOR[@]}" commit -q -F "$msg" || die push "git commit failed"
  for try in 1 2 3; do
    gh_auth_on
    if git push -q origin "HEAD:refs/heads/$branch" 2>"$WORK/push.err"; then
      gh_auth_off
      PUSHED_JSON=$(jq -nc --arg repo "$slug" --arg branch "$branch" --arg commit "$(git rev-parse HEAD)" --arg before "$SITE_BEFORE" \
        --arg source "$source" --argjson files "$files" '{ repo: $repo, branch: $branch, commit: $commit, before: $before, source: $source, files: $files }')
      log "pushed $slug $branch: ${SITE_BEFORE:0:7} -> $(git rev-parse --short=7 HEAD) ($files files)"
      cd "$P" || true
      return 0
    fi
    log "the push to $slug $branch was refused (try $try): $(grep -Eiv 'authorization|token' "$WORK/push.err" | tail -1 | cut -c1-200)"
    # The branch moved (another build, a page change): put this build's commit on its new tip.
    git fetch -q --depth 1 --filter=blob:none origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>"$WORK/fetch.err" || { gh_auth_off; die push "couldn't fetch $slug $branch again"; }
    if ! git "${GH_AUTHOR[@]}" rebase -q --onto "origin/$branch" HEAD~1 >/dev/null 2>&1; then
      git rebase --abort >/dev/null 2>&1
      gh_auth_off
      die push "$slug $branch moved during the build and the build doesn't apply on top of it: build again"
    fi
    gh_auth_off
  done
  die push "couldn't push $slug $branch after 3 tries"
}
