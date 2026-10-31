// What a bug report from this page knows (J, 2026-10-30: the 🐞 button on beta.hawkesgen.ai "should be able to have
// context when I'm submitting the bug report (screenshot, scene ids, account id, etc)"). Hawkes Studio's widget (loaded
// on the beta lane only: src/studioreport.ts) takes the screenshot and the console, and keeps this with the report.
import { state } from './account.js';
import { P, PROGRESS } from './project.js';
import { activeScene, activeKind, openTabs } from './scenes.js';

window.hawkesReportContext = () => {
  const u = state.user;
  const t = activeScene();
  return {
    app: 'Hawkes Gen',
    account: u ? { id: u.id, email: u.email, project: u.project, credits: u.credits } : null,
    admin: state.admin,
    scene: t ? { id: t.id, kind: t.kind, title: t.title } : null,
    editor: activeKind(),
    tabs: openTabs(),
    timeline: P.active ? {
      project: P.id, version: P.version, kind: P.kind, playhead: Math.round(P.playhead * 100) / 100,
      selection: { clips: [...P.selection.clips], range: P.selection.range, track: P.selection.track },
      tracks: P.doc?.tracks?.length ?? 0, clips: P.doc?.clips?.length ?? 0, unsaved: P.dirty,
    } : null,
    waiting: [...PROGRESS.entries()].slice(0, 10).map(([job, status]) => ({ job, status })),
    pane: document.querySelector('.pane-tabs .on, [data-pane].on')?.textContent?.trim() ?? null,
  };
};
