// Section 35 — JetBrains plugin Gradle build.
// Production build runs in CI with the JetBrains Runtime (JBR_BIN env)
// installed; the bun-side build:plugin script generates plugin.xml etc.
//
// Mirrors the layout JetBrains Marketplace publishers use; the actual
// `gradlew buildPlugin` step is gated on the JBR_BIN env (CI installs it
// only on the release path). On developer machines without JBR, this
// script's structural assertions still validate via the bun test layer.

plugins {
    id("org.jetbrains.kotlin.jvm") version "1.9.0"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "io.crewhaus"
version = "0.0.0"

repositories {
    mavenCentral()
}

intellij {
    version.set("2024.2")
    type.set("IC") // IntelliJ Community — applies to WebStorm/PyCharm too via Ultimate licence.
    plugins.set(listOf("org.jetbrains.plugins.yaml"))
}

kotlin {
    jvmToolchain(17)
}

tasks {
    patchPluginXml {
        sinceBuild.set("242")
        untilBuild.set("251.*")
    }
    publishPlugin {
        token.set(System.getenv("JETBRAINS_MARKETPLACE_TOKEN") ?: "")
    }
}
