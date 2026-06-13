output "argocd_namespace" {
  description = "ArgoCD namespace"
  value       = kubernetes_namespace.argocd.metadata[0].name
}

output "kubemonitor_namespace" {
  description = "KubeMonitor namespace"
  value       = kubernetes_namespace.kubemonitor.metadata[0].name
}
