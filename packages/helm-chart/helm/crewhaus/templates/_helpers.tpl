{{/*
Helpers for the crewhaus chart. Kept deliberately simple so both
real Helm and the in-process renderChart() (used by tests in
@crewhaus/helm-chart) produce equivalent output.
*/}}

{{- define "crewhaus.name" -}}
crewhaus
{{- end -}}

{{- define "crewhaus.fullname" -}}
{{ .Release.Name }}-crewhaus
{{- end -}}

{{- define "crewhaus.labels" -}}
app.kubernetes.io/name: {{ include "crewhaus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
crewhaus.ai/target: {{ .Values.target | quote }}
{{- end -}}
