import os, logging
from typing import Dict, List, Any
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

try:
    from kubernetes import client, config
    _K8S = True
except ImportError:
    _K8S = False

def parse_cpu(cpu_str: str) -> float:
    if not cpu_str:
        return 0.0
    cpu_str = str(cpu_str).strip()
    if cpu_str.endswith("n"):
        return float(cpu_str[:-1]) / 1_000_000.0
    if cpu_str.endswith("u"):
        return float(cpu_str[:-1]) / 1_000.0
    if cpu_str.endswith("m"):
        return float(cpu_str[:-1])
    try:
        return float(cpu_str) * 1000.0
    except ValueError:
        return 0.0

def parse_mem(mem_str: str) -> float:
    if not mem_str:
        return 0.0
    mem_str = str(mem_str).strip()
    if mem_str.endswith("Ki"):
        return float(mem_str[:-2]) / 1024.0
    if mem_str.endswith("Mi"):
        return float(mem_str[:-2])
    if mem_str.endswith("Gi"):
        return float(mem_str[:-2]) * 1024.0
    if mem_str.endswith("Ti"):
        return float(mem_str[:-2]) * 1024.0 * 1024.0
    try:
        return float(mem_str) / (1024.0 * 1024.0)
    except ValueError:
        return 0.0

class K8sClient:

    def __init__(self):
        self.connected = False
        self.v1 = None
        self.apps_v1 = None
        self.custom_objects = None
        if not _K8S:
            logger.warning("kubernetes lib not installed - demo mode")
            return
        try:
            config.load_incluster_config()
            self.connected = True
        except config.ConfigException:
            try:
                config.load_kube_config()
                self.connected = True
            except Exception as e:
                logger.warning("K8s unavailable - demo mode: %s", e)
        if self.connected:
            self.v1 = client.CoreV1Api()
            self.apps_v1 = client.AppsV1Api()
            self.custom_objects = client.CustomObjectsApi(self.v1.api_client)
            logger.info("K8s API connected")

    def _detect_env(self, nodes, namespaces) -> tuple:
        env_name = "Generic K8s"
        version = "v1.28.3"
        has_argocd = False
        
        try:
            v_api = client.VersionApi(self.v1.api_client)
            version = v_api.get_code().git_version
        except Exception:
            pass

        for ns in namespaces:
            if ns.metadata.name == "argocd":
                has_argocd = True

        if nodes.items:
            first_node = nodes.items[0].metadata.name.lower()
            provider_id = (nodes.items[0].spec.provider_id or "").lower()
            if "gke" in first_node or "gce" in provider_id:
                env_name = "GKE"
            elif "eks" in first_node or "aws" in provider_id:
                env_name = "AWS EKS"
            elif "aks" in first_node or "azure" in provider_id:
                env_name = "AKS"
            elif "minikube" in first_node:
                env_name = "Minikube"
            elif "k3s" in first_node:
                env_name = "K3s"
            elif "microk8s" in first_node:
                env_name = "MicroK8s"
            elif "kind" in first_node:
                env_name = "KinD"

        return env_name, version, has_argocd

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

            env_name, version, has_argocd = self._detect_env(nodes, ns.items)

            return {
                "nodes": {"total": len(nodes.items), "ready": ready},
                "pods": {"total": len(pods.items), **stats},
                "namespaces": len(ns.items),
                "cluster_health": "healthy" if ready == len(nodes.items) else "degraded",
                "env": env_name,
                "version": version,
                "argocd_status": has_argocd
            }
        except Exception as e:
            logger.error("overview error: %s", e)
            return self._mock_overview()

    def _get_pod_security_details(self, p) -> Dict[str, bool]:
        no_latest = True
        has_limits = True
        has_requests = True
        has_readiness = True
        has_liveness = True
        run_as_non_root = True

        if p.spec.containers:
            for c in p.spec.containers:
                image = c.image or ""
                parts = image.split("/")
                last_part = parts[-1]
                if ":" not in last_part or last_part.endswith(":latest"):
                    no_latest = False
                
                limits = c.resources.limits if c.resources else None
                if not limits or "cpu" not in limits or "memory" not in limits:
                    has_limits = False
                
                requests = c.resources.requests if c.resources else None
                if not requests or "cpu" not in requests or "memory" not in requests:
                    has_requests = False
                
                if not c.readiness_probe:
                    has_readiness = False
                if not c.liveness_probe:
                    has_liveness = False
                
                c_non_root = False
                if c.security_context and c.security_context.run_as_non_root is not None:
                    c_non_root = c.security_context.run_as_non_root
                else:
                    if p.spec.security_context and p.spec.security_context.run_as_non_root is not None:
                        c_non_root = p.spec.security_context.run_as_non_root
                if not c_non_root:
                    run_as_non_root = False

        return {
            "no_latest": no_latest,
            "has_limits": has_limits,
            "has_requests": has_requests,
            "has_readiness": has_readiness,
            "has_liveness": has_liveness,
            "run_as_non_root": run_as_non_root
        }

    def get_pods(self, namespace: str = None) -> List[Dict]:
        if not self.connected:
            return self._mock_pods()
        try:
            metrics_map = {}
            if self.custom_objects:
                try:
                    res = self.custom_objects.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods")
                    for item in res.get("items", []):
                        m_ns = item.get("metadata", {}).get("namespace")
                        m_name = item.get("metadata", {}).get("name")
                        metrics_map[(m_ns, m_name)] = item
                except Exception as e:
                    logger.warning("Failed to fetch pod metrics: %s", e)

            items = (self.v1.list_namespaced_pod(namespace).items
                     if namespace
                     else self.v1.list_pod_for_all_namespaces().items)
            return [self._fmt_pod(p, metrics_map.get((p.metadata.namespace, p.metadata.name))) for p in items]
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
            return ["default", "kube-system", "kube-public", "argocd", "kubemonitor"]
        try:
            return [n.metadata.name for n in self.v1.list_namespace().items]
        except Exception:
            return ["default"]

    def get_pod_logs(self, name: str, namespace: str = "default", lines: int = 80) -> str:
        if not self.connected:
            return "[Demo Mode] Pod logs unavailable without K8s connection.\n" * 5
        try:
            res = self.v1.read_namespaced_pod_log(name=name, namespace=namespace, tail_lines=lines)
            if isinstance(res, bytes):
                return res.decode('utf-8', errors='replace')
            if isinstance(res, str) and res.startswith("b'") and res.endswith("'"):
                try:
                    import ast
                    res_bytes = ast.literal_eval(res)
                    if isinstance(res_bytes, bytes):
                        return res_bytes.decode('utf-8', errors='replace')
                except Exception:
                    res = res[2:-1].replace('\\n', '\n').replace('\\t', '\t')
            return res
        except Exception as e:
            return f"Error: {e}"

    def get_events(self, namespace: str = None) -> List[Dict]:
        if not self.connected:
            return self._mock_events()
        try:
            items = (self.v1.list_namespaced_event(namespace).items
                     if namespace
                     else self.v1.list_event_for_all_namespaces().items)
            
            sorted_items = sorted(
                items,
                key=lambda x: x.last_timestamp or x.event_time or x.metadata.creation_timestamp or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True
            )
            
            events_list = []
            for e in sorted_items[:50]:
                t = e.last_timestamp or e.event_time or e.metadata.creation_timestamp
                t_str = t.strftime("%H:%M:%S") if t else datetime.now().strftime("%H:%M:%S")
                events_list.append({
                    "type": e.type or "Normal",
                    "reason": e.reason or "Unknown",
                    "object": f"{e.involved_object.kind}/{e.involved_object.name}" if e.involved_object else "Unknown",
                    "message": e.message or "",
                    "time": t_str,
                    "namespace": e.metadata.namespace or "default"
                })
            return events_list
        except Exception as e:
            err_str = str(e)
            if "403" in err_str or "Forbidden" in err_str:
                if not getattr(self, "_events_403_logged", False):
                    logger.warning("events: 403 Forbidden — add 'events' to ClusterRole. Tab will be empty until RBAC is applied.")
                    self._events_403_logged = True
            else:
                logger.error("events error: %s", e)
            return self._mock_events()

    def get_full_state(self) -> Dict[str, Any]:
        return {
            "overview": self.get_cluster_overview(),
            "nodes": self.get_nodes(),
            "pods": self.get_pods(),
            "deployments": self.get_deployments(),
            "services": self.get_services(),
            "events": self.get_events()
        }

    def _fmt_pod(self, p, metric_item=None) -> Dict:
        restarts = 0
        if p.status.container_statuses:
            restarts = sum(cs.restart_count for cs in p.status.container_statuses)
        age = ""
        if p.metadata.creation_timestamp:
            d = datetime.now(timezone.utc) - p.metadata.creation_timestamp
            age = f"{d.days}d" if d.days else (f"{d.seconds//3600}h" if d.seconds > 3600 else f"{d.seconds//60}m")
        
        primary_image = p.spec.containers[0].image if (p.spec.containers and len(p.spec.containers) > 0) else "N/A"
        sec = self._get_pod_security_details(p)

        cpu_usage = "—"
        memory_usage = "—"
        if metric_item and "containers" in metric_item:
            tot_cpu = 0.0
            tot_mem = 0.0
            for c in metric_item["containers"]:
                usage = c.get("usage", {})
                tot_cpu += parse_cpu(usage.get("cpu", "0"))
                tot_mem += parse_mem(usage.get("memory", "0"))
            cpu_usage = f"{int(tot_cpu)}m"
            memory_usage = f"{int(tot_mem)}Mi"

        return {"name": p.metadata.name, "namespace": p.metadata.namespace,
                "status": p.status.phase or "Unknown", "restarts": restarts,
                "age": age, "node": p.spec.node_name or "N/A", "ip": p.status.pod_ip or "N/A",
                "image": primary_image, "security": sec,
                "cpu_usage": cpu_usage, "memory_usage": memory_usage}

    def get_resource_details(self, resource_type: str, name: str, namespace: str) -> Dict[str, Any]:
        if not self.connected:
            return self._mock_resource_details(resource_type, name, namespace)
        try:
            if resource_type == "pod":
                res = self.v1.read_namespaced_pod(name, namespace)
            elif resource_type == "deployment":
                res = self.apps_v1.read_namespaced_deployment(name, namespace)
            elif resource_type == "service":
                res = self.v1.read_namespaced_service(name, namespace)
            else:
                return {"error": "Unsupported resource type"}
            return self.v1.api_client.sanitize_for_serialization(res)
        except Exception as e:
            logger.error("error getting details: %s", e)
            return {"error": str(e)}

    def delete_pod(self, name: str, namespace: str) -> Dict[str, Any]:
        if not self.connected:
            return {"status": "success", "message": f"[Demo Mode] Pod {name} deleted"}
        try:
            self.v1.delete_namespaced_pod(name=name, namespace=namespace)
            return {"status": "success", "message": f"Pod {name} successfully deleted"}
        except Exception as e:
            logger.error("Error deleting pod: %s", e)
            return {"status": "error", "message": str(e)}

    def scale_deployment(self, name: str, namespace: str, replicas: int) -> Dict[str, Any]:
        if not self.connected:
            return {"status": "success", "message": f"[Demo Mode] Deployment {name} scaled to {replicas}"}
        try:
            self.apps_v1.patch_namespaced_deployment_scale(
                name=name,
                namespace=namespace,
                body={"spec": {"replicas": replicas}}
            )
            return {"status": "success", "message": f"Deployment {name} successfully scaled to {replicas}"}
        except Exception as e:
            logger.error("Error scaling deployment: %s", e)
            return {"status": "error", "message": str(e)}

    def restart_deployment(self, name: str, namespace: str) -> Dict[str, Any]:
        if not self.connected:
            return {"status": "success", "message": f"[Demo Mode] Deployment {name} restarted"}
        try:
            now_iso = datetime.now(timezone.utc).isoformat()
            body = {
                "spec": {
                    "template": {
                        "metadata": {
                            "annotations": {
                                "kubectl.kubernetes.io/restartedAt": now_iso
                            }
                        }
                    }
                }
            }
            self.apps_v1.patch_namespaced_deployment(name=name, namespace=namespace, body=body)
            return {"status": "success", "message": f"Deployment {name} successfully restarted"}
        except Exception as e:
            logger.error("Error restarting deployment: %s", e)
            return {"status": "error", "message": str(e)}

    def _mock_resource_details(self, resource_type: str, name: str, namespace: str) -> Dict[str, Any]:
        now_str = datetime.now(timezone.utc).isoformat()
        metadata = {
            "name": name,
            "namespace": namespace,
            "creationTimestamp": now_str,
            "uid": "12345678-abcd-1234-abcd-1234567890ab",
            "labels": {"app": name, "monitored-by": "kubemonitor"},
            "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{}"}
        }
        if resource_type == "pod":
            return {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": metadata,
                "spec": {
                    "containers": [{
                        "name": "app",
                        "image": "nginx:1.25" if "nginx" in name else "quay.io/argoproj/argocd:v3.4.3",
                        "ports": [{"containerPort": 80, "protocol": "TCP"}],
                        "resources": {
                            "limits": {"cpu": "200m", "memory": "256Mi"},
                            "requests": {"cpu": "100m", "memory": "128Mi"}
                        },
                        "securityContext": {"runAsNonRoot": True, "allowPrivilegeEscalation": False}
                    }],
                    "nodeName": "minikube",
                    "restartPolicy": "Always"
                },
                "status": {
                    "phase": "Running",
                    "podIP": "10.244.0.15",
                    "hostIP": "192.168.49.2",
                    "startTime": now_str,
                    "containerStatuses": [{
                        "name": "app",
                        "state": {"running": {"startedAt": now_str}},
                        "ready": True,
                        "restartCount": 1
                    }]
                }
            }
        elif resource_type == "deployment":
            return {
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": metadata,
                "spec": {
                    "replicas": 1,
                    "selector": {"matchLabels": {"app": name}},
                    "template": {
                        "metadata": {"labels": {"app": name}},
                        "spec": {
                            "containers": [{
                                "name": "app",
                                "image": "nginx:1.25",
                                "resources": {}
                            }]
                        }
                    }
                },
                "status": {
                    "replicas": 1,
                    "readyReplicas": 1,
                    "availableReplicas": 1,
                    "updatedReplicas": 1
                }
            }
        elif resource_type == "service":
            return {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": metadata,
                "spec": {
                    "type": "ClusterIP",
                    "selector": {"app": name},
                    "ports": [{"port": 80, "targetPort": 80, "protocol": "TCP"}],
                    "clusterIP": "10.96.0.1"
                },
                "status": {
                    "loadBalancer": {}
                }
            }
        else:
            return {"error": "Unsupported resource type"}

    def _mock_overview(self):
        return {"nodes": {"total": 1, "ready": 1},
                "pods": {"total": 12, "Running": 10, "Pending": 1, "Failed": 1, "Succeeded": 0, "Unknown": 0},
                "namespaces": 5, "cluster_health": "healthy", "env": "Minikube", "version": "v1.28.3", "argocd_status": True}

    def _mock_pods(self):
        return [
            {"name": "kubemonitor-web-7b8d5c-x2k4p", "namespace": "kubemonitor", "status": "Running", "restarts": 0, "age": "2h", "node": "minikube", "ip": "10.244.0.15", "image": "kubemonitor-web:1.2.0", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "15m", "memory_usage": "64Mi"},
            {"name": "kubemonitor-redis-0", "namespace": "kubemonitor", "status": "Running", "restarts": 0, "age": "2h", "node": "minikube", "ip": "10.244.0.16", "image": "redis:7.2-alpine", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": False, "has_liveness": False, "run_as_non_root": True}, "cpu_usage": "2m", "memory_usage": "8Mi"},
            {"name": "argocd-server-5f8d6c-m3n1p", "namespace": "argocd", "status": "Running", "restarts": 0, "age": "5h", "node": "minikube", "ip": "10.244.0.10", "image": "argoproj/argocd:v2.10.4", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "35m", "memory_usage": "112Mi"},
            {"name": "argocd-repo-server-6d9e8f-k7j2q", "namespace": "argocd", "status": "Running", "restarts": 0, "age": "5h", "node": "minikube", "ip": "10.244.0.11", "image": "argoproj/argocd:v2.10.4", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "12m", "memory_usage": "85Mi"},
            {"name": "coredns-5d78c9-abc12", "namespace": "kube-system", "status": "Running", "restarts": 1, "age": "1d", "node": "minikube", "ip": "10.244.0.3", "image": "coredns:1.11.1", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "5m", "memory_usage": "18Mi"},
            {"name": "etcd-minikube", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "192.168.49.2", "image": "etcd:3.5.9-0", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "45m", "memory_usage": "48Mi"},
            {"name": "kube-apiserver-minikube", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "192.168.49.2", "image": "kube-apiserver:v1.28.3", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "95m", "memory_usage": "256Mi"},
            {"name": "kube-scheduler-minikube", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "192.168.49.2", "image": "kube-scheduler:v1.28.3", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "15m", "memory_usage": "32Mi"},
            {"name": "metrics-server-6d94bc-z9y8x", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "10.244.0.5", "image": "metrics-server:v0.6.4", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "8m", "memory_usage": "22Mi"},
            {"name": "nginx-demo-7f6d5e-pending", "namespace": "default", "status": "Pending", "restarts": 0, "age": "30m", "node": "N/A", "ip": "N/A", "image": "nginx:latest", "security": {"no_latest": False, "has_limits": False, "has_requests": False, "has_readiness": False, "has_liveness": False, "run_as_non_root": False}, "cpu_usage": "—", "memory_usage": "—"},
            {"name": "crash-loop-pod-abc123", "namespace": "default", "status": "Failed", "restarts": 15, "age": "2h", "node": "minikube", "ip": "10.244.0.20", "image": "broken-app:latest", "security": {"no_latest": False, "has_limits": False, "has_requests": False, "has_readiness": False, "has_liveness": False, "run_as_non_root": False}, "cpu_usage": "—", "memory_usage": "—"},
            {"name": "storage-provisioner", "namespace": "kube-system", "status": "Running", "restarts": 0, "age": "1d", "node": "minikube", "ip": "10.244.0.6", "image": "k8s-minikube/storage-provisioner:v5", "security": {"no_latest": True, "has_limits": True, "has_requests": True, "has_readiness": True, "has_liveness": True, "run_as_non_root": True}, "cpu_usage": "4m", "memory_usage": "12Mi"}
        ]
 
    def _mock_deployments(self):
        return [
            {"name": "kubemonitor-web", "namespace": "kubemonitor", "replicas": 1, "ready": 1, "available": 1},
            {"name": "argocd-server", "namespace": "argocd", "replicas": 1, "ready": 1, "available": 1},
            {"name": "coredns", "namespace": "kube-system", "replicas": 1, "ready": 1, "available": 1},
            {"name": "metrics-server", "namespace": "kube-system", "replicas": 1, "ready": 1, "available": 1},
            {"name": "nginx-demo", "namespace": "default", "replicas": 2, "ready": 1, "available": 1}
        ]
 
    def _mock_services(self):
        return [
            {"name": "kubemonitor-web", "namespace": "kubemonitor", "type": "ClusterIP", "cluster_ip": "10.96.45.12", "ports": [{"port": 8000, "target": 8000, "protocol": "TCP"}]},
            {"name": "kubemonitor-redis", "namespace": "kubemonitor", "type": "ClusterIP", "cluster_ip": "10.96.45.13", "ports": [{"port": 6379, "target": 6379, "protocol": "TCP"}]},
            {"name": "argocd-server", "namespace": "argocd", "type": "ClusterIP", "cluster_ip": "10.96.100.5", "ports": [{"port": 443, "target": 8080, "protocol": "TCP"}]},
            {"name": "kubernetes", "namespace": "default", "type": "ClusterIP", "cluster_ip": "10.96.0.1", "ports": [{"port": 443, "target": 6443, "protocol": "TCP"}]},
            {"name": "kube-dns", "namespace": "kube-system", "type": "ClusterIP", "cluster_ip": "10.96.0.10", "ports": [{"port": 53, "target": 53, "protocol": "UDP"}]}
        ]
 
    def _mock_events(self):
        return [
            {"type": "Warning", "reason": "BackOff", "object": "Pod/crash-loop-pod-abc123", "message": "Back-off restarting failed container", "time": "14:23:05", "namespace": "default"},
            {"type": "Warning", "reason": "FailedScheduling", "object": "Pod/nginx-demo-7f6d5e-pending", "message": "0/1 nodes are available: 1 Insufficient memory", "time": "14:15:20", "namespace": "default"},
            {"type": "Normal", "reason": "Pulling", "object": "Pod/kubemonitor-web-7b8d5c-x2k4p", "message": "Pulling image \"kubemonitor-web:1.2.0\"", "time": "13:45:11", "namespace": "kubemonitor"},
            {"type": "Normal", "reason": "Started", "object": "Pod/kubemonitor-redis-0", "message": "Started container redis", "time": "13:44:55", "namespace": "kubemonitor"}
        ]

    def get_nodes(self) -> List[Dict]:
        if not self.connected:
            return [
                {
                    "name": "minikube",
                    "status": "Ready",
                    "version": "v1.28.3",
                    "pods_count": 12,
                    "age": "1d"
                }
            ]
        try:
            nodes = self.v1.list_node().items
            pods = self.v1.list_pod_for_all_namespaces().items
            
            node_list = []
            for n in nodes:
                status_val = "NotReady"
                for cond in n.status.conditions:
                    if cond.type == "Ready":
                        status_val = "Ready" if cond.status == "True" else "NotReady"
                        break
                
                node_pods = sum(1 for p in pods if p.spec.node_name == n.metadata.name)
                
                age = ""
                if n.metadata.creation_timestamp:
                    d = datetime.now(timezone.utc) - n.metadata.creation_timestamp
                    age = f"{d.days}d" if d.days else (f"{d.seconds//3600}h" if d.seconds > 3600 else f"{d.seconds//60}m")
                
                node_list.append({
                    "name": n.metadata.name,
                    "status": status_val,
                    "version": n.status.node_info.kubelet_version,
                    "pods_count": node_pods,
                    "age": age
                })
            return node_list
        except Exception as e:
            logger.error("Error listing nodes: %s", e)
            return []

    def get_node_details(self, name: str) -> Dict[str, Any]:
        if not self.connected:
            return {
                "name": name,
                "os": "Ubuntu 22.04.3 LTS",
                "architecture": "amd64",
                "kubelet_version": "v1.28.3",
                "container_runtime": "containerd://1.7.3",
                "internal_ip": "192.168.49.2",
                "external_ip": "N/A",
                "cpu": {"capacity": "4", "allocatable": "4"},
                "memory": {"capacity": "8032000Ki", "allocatable": "7832000Ki"},
                "conditions": {"Ready": True, "MemoryPressure": False, "DiskPressure": False, "PIDPressure": False},
                "pods": [
                    {"name": "kubemonitor-web-7b8d5c-x2k4p", "namespace": "kubemonitor", "status": "Running", "image": "kubemonitor-web:1.2.0"}
                ]
            }
        try:
            n = self.v1.read_node(name)
            pods = self.v1.list_pod_for_all_namespaces().items
            node_pods = []
            for p in pods:
                if p.spec.node_name == name:
                    primary_image = p.spec.containers[0].image if (p.spec.containers and len(p.spec.containers) > 0) else "N/A"
                    node_pods.append({
                        "name": p.metadata.name,
                        "namespace": p.metadata.namespace,
                        "status": p.status.phase or "Unknown",
                        "image": primary_image
                    })
            
            internal_ip = "N/A"
            external_ip = "N/A"
            for addr in n.status.addresses:
                if addr.type == "InternalIP":
                    internal_ip = addr.address
                elif addr.type == "ExternalIP":
                    external_ip = addr.address

            conds = {}
            for cond in n.status.conditions:
                conds[cond.type] = cond.status == "True"

            for c_type in ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"]:
                if c_type not in conds:
                    conds[c_type] = False

            return {
                "name": n.metadata.name,
                "os": n.status.node_info.os_image,
                "architecture": n.status.node_info.architecture,
                "kubelet_version": n.status.node_info.kubelet_version,
                "container_runtime": n.status.node_info.container_runtime_version,
                "internal_ip": internal_ip,
                "external_ip": external_ip,
                "cpu": {
                    "capacity": n.status.capacity.get("cpu", "0"),
                    "allocatable": n.status.allocatable.get("cpu", "0")
                },
                "memory": {
                    "capacity": n.status.capacity.get("memory", "0"),
                    "allocatable": n.status.allocatable.get("memory", "0")
                },
                "conditions": conds,
                "pods": node_pods
            }
        except Exception as e:
            logger.error("Error reading node details: %s", e)
            return {"error": str(e)}

    def get_node_metrics(self, name: str) -> Dict[str, Any]:
        if not self.connected:
            return {
                "cpu_usage_m": 450,
                "cpu_usage_pct": 11.25,
                "ram_usage_mib": 2048,
                "ram_usage_pct": 25.5
            }
        try:
            if not self.custom_objects:
                return {
                    "cpu_usage_m": 0, "cpu_usage_pct": 0,
                    "ram_usage_mib": 0, "ram_usage_pct": 0
                }
            res = self.custom_objects.get_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes", name)
            usage = res.get("usage", {})
            cpu_raw = usage.get("cpu", "0")
            mem_raw = usage.get("memory", "0")

            cpu_usage_m = parse_cpu(cpu_raw)
            ram_usage_mib = parse_mem(mem_raw)

            node_details = self.get_node_details(name)
            cpu_cap = parse_cpu(node_details.get("cpu", {}).get("capacity", "1"))
            ram_cap = parse_mem(node_details.get("memory", {}).get("capacity", "1"))

            cpu_pct = (cpu_usage_m / cpu_cap * 100.0) if cpu_cap > 0 else 0.0
            ram_pct = (ram_usage_mib / ram_cap * 100.0) if ram_cap > 0 else 0.0

            return {
                "cpu_usage_m": int(cpu_usage_m),
                "cpu_usage_pct": round(cpu_pct, 2),
                "ram_usage_mib": int(ram_usage_mib),
                "ram_usage_pct": round(ram_pct, 2)
            }
        except Exception as e:
            logger.error("Error fetching node metrics: %s", e)
            return {
                "cpu_usage_m": 0,
                "cpu_usage_pct": 0,
                "ram_usage_mib": 0,
                "ram_usage_pct": 0
            }
