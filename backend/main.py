import os, logging, asyncio, subprocess, json
from datetime import datetime
from pydantic import BaseModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from .k8s_client import K8sClient
from .cache import RedisCache
from .websocket import ConnectionManager

class TrivyScanRequest(BaseModel):
    image: str

class ScaleRequest(BaseModel):
    replicas: int

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("kubemonitor-backend")

app = FastAPI(
    title="KubeMonitor Backend",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

k8s = K8sClient()
cache = RedisCache()
manager = ConnectionManager()

app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "..", "frontend")), name="static")

async def broadcast_k8s_state():
    logger.info("Starting background state broadcaster task...")
    while True:
        try:
            if manager.active:
                state = cache.get("k8s_state")
                if not state:
                    state = k8s.get_full_state()
                    cache.set("k8s_state", state, ttl=3)

                await manager.broadcast({
                    "type": "state_update",
                    "timestamp": os.getenv("FAKE_TIME_STAMP", "realtime"),
                    "data": state,
                })
        except Exception as e:
            logger.error("Error in background broadcast: %s", e)
        await asyncio.sleep(2)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(broadcast_k8s_state())

@app.get("/", response_class=HTMLResponse, tags=["UI Dashboard"])
@app.get("/pod/{namespace}/{name}", response_class=HTMLResponse, tags=["UI Dashboard"])
@app.get("/deployment/{namespace}/{name}", response_class=HTMLResponse, tags=["UI Dashboard"])
@app.get("/service/{namespace}/{name}", response_class=HTMLResponse, tags=["UI Dashboard"])
@app.get("/node/{name}", response_class=HTMLResponse, tags=["UI Dashboard"])
def read_root(namespace: str = None, name: str = None):
    potential_paths = [
        os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html"),
        os.path.join(os.path.dirname(__file__), "templates", "index.html"),
        os.path.join(os.getcwd(), "frontend", "index.html"),
        os.path.join(os.getcwd(), "index.html"),
    ]

    html_path = None
    for path in potential_paths:
        if os.path.exists(path):
            html_path = path
            break

    if not html_path:
        return HTMLResponse(
            content="<h1>KubeMonitor Frontend Error</h1><p>index.html was not found in directories.</p>",
            status_code=500
        )

    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)

@app.get("/api/overview", tags=["K8s Data"])
def get_overview():
    cached = cache.get("k8s_overview")
    if cached:
        return cached
    data = k8s.get_cluster_overview()
    cache.set("k8s_overview", data, ttl=5)
    return data

@app.get("/api/pods", tags=["K8s Data"])
def get_pods(namespace: str = None):
    return k8s.get_pods(namespace)

@app.get("/api/deployments", tags=["K8s Data"])
def get_deployments(namespace: str = None):
    return k8s.get_deployments(namespace)

@app.get("/api/services", tags=["K8s Data"])
def get_services(namespace: str = None):
    return k8s.get_services(namespace)

@app.get("/api/events", tags=["K8s Data"])
def get_events(namespace: str = None):
    return k8s.get_events(namespace)

@app.get("/api/namespaces", tags=["K8s Data"])
def get_namespaces():
    return k8s.get_namespaces()

@app.get("/api/logs/{namespace}/{pod_name}", tags=["K8s Data"])
def get_pod_logs(namespace: str, pod_name: str, lines: int = 100):
    return {"pod": pod_name, "namespace": namespace, "logs": k8s.get_pod_logs(pod_name, namespace, lines)}

@app.get("/api/details/{resource_type}/{namespace}/{name}", tags=["K8s Data"])
def get_resource_details(resource_type: str, namespace: str, name: str):
    return k8s.get_resource_details(resource_type, name, namespace)

@app.get("/api/nodes", tags=["K8s Data"])
def get_nodes():
    return k8s.get_nodes()

@app.get("/api/nodes/{name}", tags=["K8s Data"])
def get_node_details(name: str):
    return k8s.get_node_details(name)

@app.get("/api/nodes/{name}/metrics", tags=["K8s Data"])
def get_node_metrics(name: str):
    return k8s.get_node_metrics(name)

@app.get("/api/pods/{namespace}/{name}/metrics", tags=["K8s Data"])
def get_pod_metrics(namespace: str, name: str):
    if not k8s.connected:
        return {"cpu": "15m", "memory": "64Mi"}
    try:
        from .k8s_client import parse_cpu, parse_mem
    except ImportError:
        from k8s_client import parse_cpu, parse_mem
    try:
        res = k8s.custom_objects.get_namespaced_custom_object("metrics.k8s.io", "v1beta1", namespace, "pods", name)
        tot_cpu = 0.0
        tot_mem = 0.0
        for c in res.get("containers", []):
            usage = c.get("usage", {})
            tot_cpu += parse_cpu(usage.get("cpu", "0"))
            tot_mem += parse_mem(usage.get("memory", "0"))
        return {
            "cpu": f"{int(tot_cpu)}m",
            "memory": f"{int(tot_mem)}Mi"
        }
    except Exception as e:
        logger.error("Failed to get pod metrics: %s", e)
        return {"cpu": "—", "memory": "—"}


@app.get("/health", status_code=status.HTTP_200_OK, tags=["Operational"])
def health_check():
    return {
        "status": "healthy",
        "k8s_connected": k8s.connected,
    }

@app.get("/status", tags=["Operational"])
def get_status(response: Response):
    k8s_connected = k8s.connected
    redis_connected = cache.connected
    if not k8s_connected:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {
            "status": "unhealthy",
            "k8s_connected": False,
            "redis_connected": redis_connected
        }
    return {
        "status": "healthy",
        "k8s_connected": True,
        "redis_connected": redis_connected
    }

@app.post("/api/scan/trivy", tags=["Security"])
def scan_image_trivy(req: TrivyScanRequest):
    trivy_server = os.getenv("TRIVY_SERVER_URL", "").strip()

    if not trivy_server:
        return {
            "error": "trivy_disabled",
            "message": "Trivy is disabled. Set trivy.enabled=true in Helm values and run helm upgrade."
        }

    cmd = [
        "trivy", "image",
        "--server", trivy_server,
        "--cache-dir", "/tmp/trivy-cache",
        "--format", "json",
        "--quiet", "--no-progress",
        req.image
    ]

    try:
        process = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=300
        )
        if process.returncode != 0:
            logger.error("Trivy failed with code %d. Stdout: %s | Stderr: %s", process.returncode, process.stdout, process.stderr)
            err_msg = process.stderr.strip() or process.stdout.strip() or f"Trivy process exited with code {process.returncode}"
            return {
                "error": "scan_failed",
                "message": f"Image scan failed: {err_msg}"
            }
        
        data = json.loads(process.stdout)
        vulnerabilities = []
        severity_counts = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0}
        
        if "Results" in data:
            for result in data["Results"]:
                if "Vulnerabilities" in result:
                    for vuln in result["Vulnerabilities"]:
                        sev = (vuln.get("Severity") or "LOW").upper()
                        if sev in severity_counts:
                            severity_counts[sev] += 1
                        
                        vulnerabilities.append({
                            "cve": vuln.get("VulnerabilityID") or "N/A",
                            "package": vuln.get("PkgName") or "N/A",
                            "severity": sev,
                            "fixed_in": vuln.get("FixedVersion") or "-"
                        })
                        
        severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        vulnerabilities.sort(key=lambda x: severity_order.get(x["severity"], 4))
        
        return {
            "image": req.image,
            "scan_time": datetime.now().strftime("%d.%m.%Y %H:%M"),
            "counts": severity_counts,
            "vulnerabilities": vulnerabilities[:100]
        }
    except subprocess.TimeoutExpired:
        return {
            "error": "timeout",
            "message": "Image scan timed out. The Trivy pod may still be downloading the vulnerability DB."
        }
    except Exception as e:
        logger.error("Trivy scan error: %s", e)
        return {
            "error": "exception",
            "message": f"Unexpected error: {str(e)}"
        }

@app.delete("/api/pods/{namespace}/{name}", tags=["K8s Actions"])
def delete_pod(namespace: str, name: str):
    return k8s.delete_pod(name, namespace)

@app.patch("/api/deployments/{namespace}/{name}/scale", tags=["K8s Actions"])
def scale_deployment(namespace: str, name: str, req: ScaleRequest):
    return k8s.scale_deployment(name, namespace, req.replicas)

@app.post("/api/deployments/{namespace}/{name}/restart", tags=["K8s Actions"])
def restart_deployment(namespace: str, name: str):
    return k8s.restart_deployment(name, namespace)

@app.get("/metrics", tags=["Operational"])
def get_metrics():
    overview = k8s.get_cluster_overview()
    pods_total = overview["pods"]["total"]
    pods_running = overview["pods"].get("Running", 0)
    pods_failed = overview["pods"].get("Failed", 0)
    nodes_total = overview["nodes"]["total"]
    nodes_ready = overview["nodes"]["ready"]

    metrics_payload = (
        f"# HELP kubemonitor_info Info about the application\n"
        f'kubemonitor_info{{name="kubemonitor",version="1.0.0"}} 1\n'
        f"# HELP kubemonitor_pods_total Total number of pods in the cluster\n"
        f"kubemonitor_pods_total {pods_total}\n"
        f"# HELP kubemonitor_pods_running Number of running pods\n"
        f"kubemonitor_pods_running {pods_running}\n"
        f"# HELP kubemonitor_pods_failed Number of failed pods\n"
        f"kubemonitor_pods_failed {pods_failed}\n"
        f"# HELP kubemonitor_nodes_total Total nodes in the cluster\n"
        f"kubemonitor_nodes_total {nodes_total}\n"
        f"# HELP kubemonitor_nodes_ready Number of ready nodes\n"
        f"kubemonitor_nodes_ready {nodes_ready}\n"
    )
    return Response(content=metrics_payload, media_type="text/plain")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        state = k8s.get_full_state()
        await websocket.send_json({
            "type": "initial_state",
            "data": state
        })
        while True:
            data = await websocket.receive_text()
            logger.info("Received from client: %s", data)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
