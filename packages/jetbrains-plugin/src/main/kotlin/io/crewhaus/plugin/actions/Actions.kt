package io.crewhaus.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class RunSpecAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        // Production: shells to `crewhaus run <activeFile>` and routes
        // the SSE trace stream into a tool-window panel that embeds the
        // §31 Studio v1 webview. The scaffold here just registers the
        // action so the action ID is real.
    }
}

class OpenTraceAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        // Production: opens the Studio trace viewer for the most recent
        // run of the active spec.
    }
}
