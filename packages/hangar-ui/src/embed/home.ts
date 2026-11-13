/**
 * The console's own assets: the shell page, the stylesheet, and every module
 * Home ships today, keyed by serve path. Imported `with { type: "text" }`
 * one by one (STATIC imports only — see `../index.ts`), so a compiled binary
 * carries each file's text.
 *
 * A later area adds its modules to its own embed file beside this one, never
 * to this one; `../index.ts` spreads them all.
 */
import hangarCss from "../../assets/hangar.css" with { type: "text" };
// bun-types declares `*.html` imports as HTMLBundle (Bun's HTML-bundle
// feature) and that ambient wins over a local one, but the `type: "text"`
// import attribute makes this a plain string at runtime — hence the cast.
import indexHtmlBundle from "../../assets/index.html" with { type: "text" };
import apiJs from "../../assets/js/api.js" with { type: "text" };
import appJs from "../../assets/js/app.js" with { type: "text" };
import destinationsJs from "../../assets/js/destinations.js" with { type: "text" };
import domJs from "../../assets/js/dom.js" with { type: "text" };
import keysJs from "../../assets/js/keys.js" with { type: "text" };
import markdownJs from "../../assets/js/markdown.js" with { type: "text" };
import navigationJs from "../../assets/js/navigation.js" with { type: "text" };
import notifyJs from "../../assets/js/notify.js" with { type: "text" };
import omniboxJs from "../../assets/js/omnibox.js" with { type: "text" };
import prefsJs from "../../assets/js/prefs.js" with { type: "text" };
import routerJs from "../../assets/js/router.js" with { type: "text" };
import routesJs from "../../assets/js/routes.js" with { type: "text" };
import sealedJs from "../../assets/js/sealed.js" with { type: "text" };
import indexSectionJs from "../../assets/js/sections/index.js" with { type: "text" };
import knowledgeSectionJs from "../../assets/js/sections/knowledge.js" with { type: "text" };
import overviewSectionJs from "../../assets/js/sections/overview.js" with { type: "text" };
import qualitySectionJs from "../../assets/js/sections/quality.js" with { type: "text" };
import setupSectionJs from "../../assets/js/sections/setup.js" with { type: "text" };
import stackSectionJs from "../../assets/js/sections/stack.js" with { type: "text" };
import workSectionJs from "../../assets/js/sections/work.js" with { type: "text" };
import shapesJs from "../../assets/js/shapes.js" with { type: "text" };
import shellJs from "../../assets/js/shell.js" with { type: "text" };
import signInJs from "../../assets/js/sign-in.js" with { type: "text" };
import supervisionJs from "../../assets/js/supervision.js" with { type: "text" };
import chartUiJs from "../../assets/js/ui/chart.js" with { type: "text" };
import conflictUiJs from "../../assets/js/ui/conflict.js" with { type: "text" };
import dialogUiJs from "../../assets/js/ui/dialog.js" with { type: "text" };
import draftUiJs from "../../assets/js/ui/draft.js" with { type: "text" };
import emptyUiJs from "../../assets/js/ui/empty.js" with { type: "text" };
import keyedUiJs from "../../assets/js/ui/keyed.js" with { type: "text" };
import listboxUiJs from "../../assets/js/ui/listbox.js" with { type: "text" };
import liveUiJs from "../../assets/js/ui/live.js" with { type: "text" };
import panelsUiJs from "../../assets/js/ui/panels.js" with { type: "text" };
import timeUiJs from "../../assets/js/ui/time.js" with { type: "text" };
import toggleUiJs from "../../assets/js/ui/toggle.js" with { type: "text" };
import tooltipUiJs from "../../assets/js/ui/tooltip.js" with { type: "text" };
import utilJs from "../../assets/js/util.js" with { type: "text" };
import activityViewJs from "../../assets/js/views/activity.js" with { type: "text" };
import advisorViewJs from "../../assets/js/views/advisor.js" with { type: "text" };
import approvalsViewJs from "../../assets/js/views/approvals.js" with { type: "text" };
import channelsViewJs from "../../assets/js/views/channels.js" with { type: "text" };
import connectionsViewJs from "../../assets/js/views/connections.js" with { type: "text" };
import controlViewJs from "../../assets/js/views/control.js" with { type: "text" };
import costsViewJs from "../../assets/js/views/costs.js" with { type: "text" };
import credsViewJs from "../../assets/js/views/creds.js" with { type: "text" };
import dataViewJs from "../../assets/js/views/data.js" with { type: "text" };
import deployViewJs from "../../assets/js/views/deploy.js" with { type: "text" };
import evalsLabViewJs from "../../assets/js/views/evals-lab.js" with { type: "text" };
import evalsViewJs from "../../assets/js/views/evals.js" with { type: "text" };
import feedbackViewJs from "../../assets/js/views/feedback.js" with { type: "text" };
import healthViewJs from "../../assets/js/views/health.js" with { type: "text" };
import homeViewJs from "../../assets/js/views/home.js" with { type: "text" };
import inboxViewJs from "../../assets/js/views/inbox.js" with { type: "text" };
import inspectViewJs from "../../assets/js/views/inspect.js" with { type: "text" };
import jobsViewJs from "../../assets/js/views/jobs.js" with { type: "text" };
import libraryViewJs from "../../assets/js/views/library.js" with { type: "text" };
import memoryFabricViewJs from "../../assets/js/views/memory-fabric.js" with { type: "text" };
import memoryViewJs from "../../assets/js/views/memory.js" with { type: "text" };
import modelsViewJs from "../../assets/js/views/models.js" with { type: "text" };
import needsYouViewJs from "../../assets/js/views/needs-you.js" with { type: "text" };
import onboardingViewJs from "../../assets/js/views/onboarding.js" with { type: "text" };
import overviewViewJs from "../../assets/js/views/overview.js" with { type: "text" };
import panesViewJs from "../../assets/js/views/panes.js" with { type: "text" };
import peopleViewJs from "../../assets/js/views/people.js" with { type: "text" };
import procViewJs from "../../assets/js/views/proc.js" with { type: "text" };
import reviewViewJs from "../../assets/js/views/review.js" with { type: "text" };
import runsViewJs from "../../assets/js/views/runs.js" with { type: "text" };
import runtimeViewJs from "../../assets/js/views/runtime.js" with { type: "text" };
import schedulersViewJs from "../../assets/js/views/schedulers.js" with { type: "text" };
import securityViewJs from "../../assets/js/views/security.js" with { type: "text" };
import sessionsViewJs from "../../assets/js/views/sessions.js" with { type: "text" };
import settingsIndexViewJs from "../../assets/js/views/settings-index.js" with { type: "text" };
import settingsViewJs from "../../assets/js/views/settings.js" with { type: "text" };
import signInViewJs from "../../assets/js/views/sign-in.js" with { type: "text" };
import specEditViewJs from "../../assets/js/views/spec-edit.js" with { type: "text" };
import specViewJs from "../../assets/js/views/spec.js" with { type: "text" };
import thredzViewJs from "../../assets/js/views/thredz.js" with { type: "text" };
import { type HangarAsset, asset } from "./asset";

const indexHtml = indexHtmlBundle as unknown as string;

/** `"/"` is the shell (the app is a hash router, so `/` is its only page). */
export const homeAssets: Readonly<Record<string, HangarAsset>> = {
  "/": asset(indexHtml, "index.html"),
  "/assets/hangar.css": asset(hangarCss, "hangar.css"),
  "/assets/js/api.js": asset(apiJs, "api.js"),
  "/assets/js/app.js": asset(appJs, "app.js"),
  "/assets/js/destinations.js": asset(destinationsJs, "destinations.js"),
  "/assets/js/dom.js": asset(domJs, "dom.js"),
  "/assets/js/keys.js": asset(keysJs, "keys.js"),
  "/assets/js/markdown.js": asset(markdownJs, "markdown.js"),
  "/assets/js/navigation.js": asset(navigationJs, "navigation.js"),
  "/assets/js/notify.js": asset(notifyJs, "notify.js"),
  "/assets/js/omnibox.js": asset(omniboxJs, "omnibox.js"),
  "/assets/js/prefs.js": asset(prefsJs, "prefs.js"),
  "/assets/js/router.js": asset(routerJs, "router.js"),
  "/assets/js/routes.js": asset(routesJs, "routes.js"),
  "/assets/js/sealed.js": asset(sealedJs, "sealed.js"),
  "/assets/js/sections/index.js": asset(indexSectionJs, "index.js"),
  "/assets/js/sections/knowledge.js": asset(knowledgeSectionJs, "knowledge.js"),
  "/assets/js/sections/overview.js": asset(overviewSectionJs, "overview.js"),
  "/assets/js/sections/quality.js": asset(qualitySectionJs, "quality.js"),
  "/assets/js/sections/setup.js": asset(setupSectionJs, "setup.js"),
  "/assets/js/sections/stack.js": asset(stackSectionJs, "stack.js"),
  "/assets/js/sections/work.js": asset(workSectionJs, "work.js"),
  "/assets/js/shapes.js": asset(shapesJs, "shapes.js"),
  "/assets/js/shell.js": asset(shellJs, "shell.js"),
  "/assets/js/sign-in.js": asset(signInJs, "sign-in.js"),
  "/assets/js/supervision.js": asset(supervisionJs, "supervision.js"),
  "/assets/js/ui/chart.js": asset(chartUiJs, "chart.js"),
  "/assets/js/ui/conflict.js": asset(conflictUiJs, "conflict.js"),
  "/assets/js/ui/dialog.js": asset(dialogUiJs, "dialog.js"),
  "/assets/js/ui/draft.js": asset(draftUiJs, "draft.js"),
  "/assets/js/ui/empty.js": asset(emptyUiJs, "empty.js"),
  "/assets/js/ui/keyed.js": asset(keyedUiJs, "keyed.js"),
  "/assets/js/ui/listbox.js": asset(listboxUiJs, "listbox.js"),
  "/assets/js/ui/live.js": asset(liveUiJs, "live.js"),
  "/assets/js/ui/panels.js": asset(panelsUiJs, "panels.js"),
  "/assets/js/ui/time.js": asset(timeUiJs, "time.js"),
  "/assets/js/ui/toggle.js": asset(toggleUiJs, "toggle.js"),
  "/assets/js/ui/tooltip.js": asset(tooltipUiJs, "tooltip.js"),
  "/assets/js/util.js": asset(utilJs, "util.js"),
  "/assets/js/views/activity.js": asset(activityViewJs, "activity.js"),
  "/assets/js/views/advisor.js": asset(advisorViewJs, "advisor.js"),
  "/assets/js/views/approvals.js": asset(approvalsViewJs, "approvals.js"),
  "/assets/js/views/channels.js": asset(channelsViewJs, "channels.js"),
  "/assets/js/views/connections.js": asset(connectionsViewJs, "connections.js"),
  "/assets/js/views/control.js": asset(controlViewJs, "control.js"),
  "/assets/js/views/costs.js": asset(costsViewJs, "costs.js"),
  "/assets/js/views/creds.js": asset(credsViewJs, "creds.js"),
  "/assets/js/views/data.js": asset(dataViewJs, "data.js"),
  "/assets/js/views/deploy.js": asset(deployViewJs, "deploy.js"),
  "/assets/js/views/evals-lab.js": asset(evalsLabViewJs, "evals-lab.js"),
  "/assets/js/views/evals.js": asset(evalsViewJs, "evals.js"),
  "/assets/js/views/feedback.js": asset(feedbackViewJs, "feedback.js"),
  "/assets/js/views/health.js": asset(healthViewJs, "health.js"),
  "/assets/js/views/home.js": asset(homeViewJs, "home.js"),
  "/assets/js/views/inbox.js": asset(inboxViewJs, "inbox.js"),
  "/assets/js/views/inspect.js": asset(inspectViewJs, "inspect.js"),
  "/assets/js/views/jobs.js": asset(jobsViewJs, "jobs.js"),
  "/assets/js/views/library.js": asset(libraryViewJs, "library.js"),
  "/assets/js/views/memory-fabric.js": asset(memoryFabricViewJs, "memory-fabric.js"),
  "/assets/js/views/memory.js": asset(memoryViewJs, "memory.js"),
  "/assets/js/views/models.js": asset(modelsViewJs, "models.js"),
  "/assets/js/views/needs-you.js": asset(needsYouViewJs, "needs-you.js"),
  "/assets/js/views/onboarding.js": asset(onboardingViewJs, "onboarding.js"),
  "/assets/js/views/overview.js": asset(overviewViewJs, "overview.js"),
  "/assets/js/views/panes.js": asset(panesViewJs, "panes.js"),
  "/assets/js/views/people.js": asset(peopleViewJs, "people.js"),
  "/assets/js/views/proc.js": asset(procViewJs, "proc.js"),
  "/assets/js/views/review.js": asset(reviewViewJs, "review.js"),
  "/assets/js/views/runs.js": asset(runsViewJs, "runs.js"),
  "/assets/js/views/runtime.js": asset(runtimeViewJs, "runtime.js"),
  "/assets/js/views/schedulers.js": asset(schedulersViewJs, "schedulers.js"),
  "/assets/js/views/security.js": asset(securityViewJs, "security.js"),
  "/assets/js/views/sessions.js": asset(sessionsViewJs, "sessions.js"),
  "/assets/js/views/settings-index.js": asset(settingsIndexViewJs, "settings-index.js"),
  "/assets/js/views/settings.js": asset(settingsViewJs, "settings.js"),
  "/assets/js/views/sign-in.js": asset(signInViewJs, "sign-in.js"),
  "/assets/js/views/spec-edit.js": asset(specEditViewJs, "spec-edit.js"),
  "/assets/js/views/spec.js": asset(specViewJs, "spec.js"),
  "/assets/js/views/thredz.js": asset(thredzViewJs, "thredz.js"),
};
