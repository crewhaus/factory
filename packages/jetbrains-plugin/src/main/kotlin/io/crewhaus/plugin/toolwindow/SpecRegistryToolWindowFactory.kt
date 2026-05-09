package io.crewhaus.plugin.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory

/**
 * Tool window that lists specs from the §28 spec-registry. The
 * production implementation queries the configured Postgres adapter via
 * IntelliJ's Database tools; this scaffold ships the registration so
 * the marketplace bundle is structurally complete. The data layer lands
 * in a follow-up that wires the Postgres driver.
 */
class SpecRegistryToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // Scaffold — concrete UI lands in a follow-up PR.
    }
}
