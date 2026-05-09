/*
 * CrewHaus JetBrains plugin — top-level scaffold.
 *
 * Production build: `./gradlew buildPlugin` produces a .zip ready for
 * "Install plugin from disk" in IntelliJ. The bun-side test layer
 * (src/scripts/build.test.ts) verifies the plugin.xml + Kotlin layout
 * without requiring the JetBrains Runtime.
 */
package io.crewhaus.plugin

import com.intellij.openapi.components.Service

@Service(Service.Level.APP)
class CrewhausPluginService {
    fun describe(): String = "CrewHaus JetBrains plugin v0.0.0"
}
