# Changelog

## 0.2.1 (2026-10-26)

- A game with no server of its own joins with its account's project (`usr_...`) once its sites are listed on
  net.hawkesgen.com ("Your game's sites"); localhost always may, in test rooms. Readme: "Your own game: getting in".
- Sample **Avatars**: one script makes a walking capsule and everyone else's, through `HawkesNetAvatars`.
- No code changes in Runtime.

## 0.2.0 (2026-10-26)

- `HawkesNetLobby`: shared rooms by area (live, test and playtest names, shards when full, rejoining, one status).
- `HawkesNetAvatars`: drop-in avatars from a prefab.
- The room: `SendText`, pose extras, `OnPose`/`OnStatus`, `Order`/`PeerOrder`, `ClosedBecause`, `HawkesNet.Count`.

## 0.1.0 (2026-10-25)

- `HawkesNet.Join(room, options)`: messages, poses, peers, host, transport, through the web SDK in the page.
