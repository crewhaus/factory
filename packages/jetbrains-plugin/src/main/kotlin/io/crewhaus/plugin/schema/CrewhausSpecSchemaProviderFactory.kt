package io.crewhaus.plugin.schema

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.jetbrains.jsonSchema.extension.JsonSchemaFileProvider
import com.jetbrains.jsonSchema.extension.JsonSchemaProviderFactory
import com.jetbrains.jsonSchema.extension.SchemaType

/**
 * Wires VS Code's `schemas/spec.json` (shipped from
 * `@crewhaus/vscode-extension`) into IntelliJ's YAML plugin so
 * crewhaus.yaml files get the same autocomplete + lint as VS Code.
 *
 * The schema is bundled as a resource; the build script copies it from
 * the workspace at gradle assemble time.
 */
class CrewhausSpecSchemaProviderFactory : JsonSchemaProviderFactory {
    override fun getProviders(project: Project): List<JsonSchemaFileProvider> =
        listOf(CrewhausSpecSchemaProvider())
}

class CrewhausSpecSchemaProvider : JsonSchemaFileProvider {
    override fun isAvailable(file: VirtualFile): Boolean =
        file.name == "crewhaus.yaml" || file.name.endsWith(".crewhaus.yaml")

    override fun getName(): String = "CrewHaus Spec"
    override fun getSchemaFile(): VirtualFile? =
        com.intellij.openapi.application.ApplicationManager.getApplication()
            .let {
                javaClass.classLoader
                    .getResource("schemas/spec.json")
                    ?.let(com.intellij.openapi.vfs.VfsUtil::findFileByURL)
            }

    override fun getSchemaType(): SchemaType = SchemaType.embeddedSchema
}
