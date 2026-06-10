output "argocd_namespace" {
  description = "ArgoCD namespace"
  value       = kubernetes_namespace.argocd.metadata[0].name
}

output "infrapulse_namespace" {
  description = "InfraPulse namespace"
  value       = kubernetes_namespace.infrapulse.metadata[0].name
}
