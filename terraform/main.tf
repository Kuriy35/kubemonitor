terraform {
  required_version = ">= 1.3.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.20"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.9"
    }
  }
}

provider "kubernetes" {
  config_path = var.kubeconfig_path
}

provider "helm" {
  kubernetes {
    config_path = var.kubeconfig_path
  }
}

# Create ArgoCD Namespace
resource "kubernetes_namespace" "argocd" {
  metadata {
    name = "argocd"
  }
}

# Create InfraPulse Namespace
resource "kubernetes_namespace" "infrapulse" {
  metadata {
    name = "infrapulse"
  }
}

# Deploy ArgoCD via Helm Chart
resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "5.27.3"
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  set {
    name  = "server.service.type"
    value = "NodePort"
  }

  set {
    name  = "configs.params.server.insecure"
    value = "true"
  }
}

# Deploy Kubernetes Metrics Server for monitoring addons
resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.10.0"
  namespace  = "kube-system"

  set {
    name  = "args[0]"
    value = "--kubelet-insecure-tls"
  }
}
