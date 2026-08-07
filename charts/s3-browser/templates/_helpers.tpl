{{- define "s3-browser.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "s3-browser.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "s3-browser.name" . }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "s3-browser.postgresqlFullname" -}}
{{- printf "%s-postgresql" (include "s3-browser.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "s3-browser.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "s3-browser.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "s3-browser.labels" -}}
app.kubernetes.io/name: {{ include "s3-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}

{{- define "s3-browser.selectorLabels" -}}
app.kubernetes.io/name: {{ include "s3-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: application
{{- end }}

{{- define "s3-browser.postgresqlSelectorLabels" -}}
app.kubernetes.io/name: {{ include "s3-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgresql
{{- end }}
