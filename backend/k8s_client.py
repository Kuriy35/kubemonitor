import os, logging
from typing import Dict, List, Any
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

try:
    from kubernetes import client, config
    _K8S = True
except ImportError:
    _K8S = False


class K8sClient:
    """Інтеграція з Kubernetes API (in-cluster / kubeconfig / demo mode)."""

    def __init__(self):
        self.connected = False
        self.v1 = None
        self.apps_v1 = None
        if not _K8S:
            logger.warning("kubernetes lib not installed — demo mode")
            return
        try:
            config.load_incluster_config()
            self.connected = True
        except config.ConfigException:
            try:
                config.load_kube_config()
                self.connected = True
            except Exception as e:
                logger.warning("K8s unavailable — demo mode: %s", e)
        if self.connected:
            self.v1 = client.CoreV1Api()
            self.apps_v1 = client.AppsV1Api()
            logger.info("K8s API connected")

    # ── public API ──────────────────────────────────────────

    def get_cluster_overview(self) -> Dict[str, Any]:
        if not self.connected:
            return self._mock_overview()
        try:
            nodes = self.v1.list_node()
            pods = self.v1.list_pod_for_all_namespaces()
            ns = self.v1.list_namespace()
            ready = sum(1 for n in nodes.items for c in n.status.conditions
                        if c.type == "Ready" and c.status == "True")
            stats = {"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
            for p in pods.items:
                ph = p.status.phase or "Unknown"
                stats[ph] = stats.get(ph, 0) + 1
            return {
                "nodes": {"total": len(nodes.items), "ready": ready},
                "pods": {"total": len(pods.items), **stats},
                "namespaces": len(ns.items),
                "cluster_health": "healthy" if ready == len(nodes.items) else "degraded",
            }
        except Exception as e:
            logger.error("overview error: %s", e)
            return self._mock_overview()

    def get_pods(self, namespace: str = None) -> List[Dict]:
        if not self.connected:
            return self._mock_pods()
        try:
            items = (self.v1.list_namespaced_pod(namespace).items
                     if namespace
                     else self.v1.list_pod_for_all_namespaces().items)
            return [self._fmt_pod(p) for p in items]
        except Exception as e:
            logger.error("pods error: %s", e)
            return self._mock_pods()

    def get_deployments(self, namespace: str = None) -> List[Dict]:
        if not self.connected:
            return self._mock_deployments()
        try:
            items = (self.apps_v1.list_namespaced_deployment(namespace).items
                     if namespace
                     else self.apps_v1.list_deployment_for_all_namespaces().items)
            return [{"name": d.metadata.name, "namespace": d.metadata.namespace,
                      "replicas": d.spec.replicas or 0, "ready": d.status.ready_replicas or 0,
                      "available": d.status.available_replicas or 0}
                     for d in items]
        except Exception as e:
            logger.error("deployments error: %s", e)
            return self._mock_deployments()

    def get_services(self, namespace: str = None) -> List[Dict]:
        if not self.connected:
            return self._mock_services()
        try:
            items = (self.v1.list_namespaced_service(namespace).items
                     if namespace
                     else self.v1.list_service_for_all_namespaces().items)
            return [{"name": s.metadata.name, "namespace": s.metadata.namespace,
                      "type": s.spec.type, "cluster_ip": s.spec.cluster_ip or "N/A",
                      "ports": [{"port": p.port, "target": p.target_port, "protocol": p.protocol}
                                for p in (s.spec.ports or [])]}
                     for s in items]
        except Exception as e:
            logger.error("services error: %s", e)
            return self._mock_services()

    def get_namespaces(self) -> List[str]:
        if not self.connected:
            return ["default", "kube-system", "kube-public", "argocd", "infrapulse"]
        try:
            return [n.metadata.name for n in self.v1.list_namespace().items]
        except Exception:
            return ["default"]

    def get_pod_logs(self, name: str, namespace: str = "default", lines: int = 80) -> str:
        if not self.connected:
            return "[Demo Mode] Pod logs unavailable without K8s connection.\n" * 5
        try:
            return self.v1.read_namespaced_pod_log(name=name, namespace=namespace, tail_lines=lines)
        except Exception as e:
            return f"Error: {e}"

    def get_full_state(self) -> Dict[str, Any]:
        return {
            "overview": self.get_cluster_overview(),
            "pods": self.get_pods(),
            "deployments": self.get_deployments(),
            "services": self.get_services(),
        }

    # ── helpers ─────────────────────────────────────────────

    def _fmt_pod(self, p) -> Dict:
        restarts = 0
        if p.status.container_statuses:
            restarts = sum(cs.restart_count for cs in p.status.container_statuses)
        age = ""
        if p.metadata.creation_timestamp:
            d = datetime.now(timezone.utc) - p.metadata.creation_timestamp
            age = f"{d.days}d" if d.days else (f"{d.seconds//3600}h" if d.seconds > 3600 else f"{d.seconds//60}m")
        return {"name": p.metadata.name, "namespace": p.metadata.namespace,
                "status": p.status.phase or "Unknown", "restarts": restarts,
                "age": age, "node": p.spec.node_name or "N/A", "ip": p.status.pod_ip or "N/A"}

    # ── mock data ───────────────────────────────────────────

    def _mock_overview(self):
        return {"nodes": {"total": 1, "ready": 1},
                "pods": {"total": 12, "Running": 10, "Pending": 1, "Failed": 1, "Succeeded": 0, "Unknown": 0},
                "namespaces": 5, "cluster_health": "healthy"}

    def _mock_pods(self):
        return [
            {"name": "infrapulse-web-7b8d5c-x2k4p", "namespace": "infrapulse", "status": "Running", "restarts": 0, "age": "2h", "node": "minikube", "ip": "10.244.0.15"},
            {"name": "infrapulse-redis-0", "namespace": "infrapulse", "status": "Running", "restarts": 0, "age": "2h", "node": "minikube", "ip": "10.244.0.16"},
            {"name": "argocd-server-5f8d6c-m3n1p", "namespace": "argocd", "status": "Running", "restarts": 0, "age": "5h", "node": "minikube", "ip": "10.244.0.10"},
            {"name": "argocd-repo-server-6d9e8f-k7j2q", "namespace": "argocd", "status": "Running", "restarts": 0, "age": "5h", "node": "minikube", "ip": "10.244.0.11"},
            {"name": "coredns-5d78c9-abc12", "namespace": "kube-system", "status": "Running", "restarts": 1, "age": "1d", "node": "minikube", "ip": "10.244.0.3"},
            {"name": "etcd-minikube", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "192.168.49.2"},
            {"name": "kube-apiserver-minikube", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "192.168.49.2"},
            {"name": "kube-scheduler-minikube", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "192.168.49.2"},
            {"name": "metrics-server-6d94bc-z9y8x", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "10.244.0.5"},
            {"name": "nginx-demo-7f6d5e-pending", "namespace": "default", "status": "Pending", "restarts": 0, "age": "30m", "node": "N/A", "ip": "N/A"},
            {"name": "crash-loop-pod-abc123", "namespace": "default", "status": "Failed", "restarts": 15, "age": "2h", "node": "minikube", "ip": "10.244.0.20"},
            {"name": "storage-provisioner", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "10.244.0.6"},
        ]

    def _mock_deployments(self):
        return [
            {"name": "infrapulse-web", "namespace": "infrapulse", "replicas": 1, "ready": 1, "available": 1},
            {"name": "argocd-server", "namespace": "argocd", "replicas": 1, "ready": 1, "available": 1},
            {"name": "coredns", "namespace": "kube-system", "replicas": 1, "ready": 1, "available": 1},
            {"name": "metrics-server", "namespace": "kube-system", "replicas": 1, "ready": 1, "available": 1},
            {"name": "nginx-demo", "namespace": "default", "replicas": 2, "ready": 1, "available": 1},
        ]

    def _mock_services(self):
        return [
            {"name": "infrapulse-web", "namespace": "infrapulse", "type": "ClusterIP", "cluster_ip": "10.96.45.12", "ports": [{"port": 8000, "target": 8000, "protocol": "TCP"}]},
            {"name": "infrapulse-redis", "namespace": "infrapulse", "type": "ClusterIP", "cluster_ip": "10.96.45.13", "ports": [{"port": 6379, "target": 6379, "protocol": "TCP"}]},
            {"name": "argocd-server", "namespace": "argocd", "type": "ClusterIP", "cluster_ip": "10.96.100.5", "ports": [{"port": 443, "target": 8080, "protocol": "TCP"}]},
            {"name": "kubernetes", "namespace": "default", "type": "ClusterIP", "cluster_ip": "10.96.0.1", "ports": [{"port": 443, "target": 6443, "protocol": "TCP"}]},
            {"name": "kube-dns", "namespace": "kube-system", "type": "ClusterIP", "cluster_ip": "10.96.0.10", "ports": [{"port": 53, "target": 53, "protocol": "UDP"}]},
        ]
