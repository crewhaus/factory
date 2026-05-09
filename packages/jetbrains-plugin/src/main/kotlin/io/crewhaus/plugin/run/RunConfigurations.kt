package io.crewhaus.plugin.run

import com.intellij.execution.configurations.ConfigurationFactory
import com.intellij.execution.configurations.ConfigurationType

class RunSpecConfigurationType : ConfigurationType {
    override fun getDisplayName() = "CrewHaus: Run Spec"
    override fun getConfigurationTypeDescription() = "Run a CrewHaus spec via `crewhaus run <spec>`"
    override fun getIcon() = null
    override fun getId() = "io.crewhaus.runSpec"
    override fun getConfigurationFactories(): Array<ConfigurationFactory> = emptyArray()
}

class RunEvalConfigurationType : ConfigurationType {
    override fun getDisplayName() = "CrewHaus: Run Eval"
    override fun getConfigurationTypeDescription() = "Run a CrewHaus eval bundle via `crewhaus eval <spec>`"
    override fun getIcon() = null
    override fun getId() = "io.crewhaus.runEval"
    override fun getConfigurationFactories(): Array<ConfigurationFactory> = emptyArray()
}

class RunCanaryConfigurationType : ConfigurationType {
    override fun getDisplayName() = "CrewHaus: Run Canary"
    override fun getConfigurationTypeDescription() =
        "Promote a spec via §28 canary-controller (`crewhaus deploy promote ... --canary`)"
    override fun getIcon() = null
    override fun getId() = "io.crewhaus.runCanary"
    override fun getConfigurationFactories(): Array<ConfigurationFactory> = emptyArray()
}
