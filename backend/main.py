import os
import asyncio
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, status
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

from .k8s_client import K8sClient
from .cache import RedisCache
from .websocket import ConnectionManager

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("infrapulse-backend")

app = FastAPI(
    title="Infrapulse API",
    description="Backend API для моніторингу стану кластера Kubernetes в реальному часі.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize components
k8s = K8sClient()
cache = RedisCache()
manager = ConnectionManager()

# Background broadcast task
async def broadcast_k8s_state():
    logger.info("Starting background state broadcaster task...")
    while True:
        try:
            if manager.active:
                # Get current state from cache or fetch from K8s API
                state = cache.get("k8s_state")
                if not state:
                    state = k8s.get_full_state()
                    cache.set("k8s_state", state, ttl=3) # cache for 3s
                
                await manager.broadcast({
                    "type": "state_update",
                    "timestamp": os.getenv("FAKE_TIME_STAMP", "realtime"),
                    "data": state
                })
        except Exception as e:
            logger.error("Error in background broadcast: %s", e)
        await asyncio.sleep(2) # Update every 2 seconds

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(broadcast_k8s_state())

# --- Frontend Serving ---
@app.get("/", response_class=HTMLResponse, tags=["UI Dashboard"])
def read_root():
    """
    Serves the main interactive dashboard user interface.
    """
    # Look for frontend files relative to app or in frontend/ folder
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
        # Fallback page if file is not found
        return HTMLResponse(
            content="<h1>InfraPulse Frontend Error</h1><p>index.html was not found in directories.</p>",
            status_code=500
        )
        
    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)

# --- REST API Endpoints ---
@app.get("/api/overview", tags=["K8s Data"])
def get_overview():
    cached = cache.get("k8s_overview")
    if not cached:
        cached = k8s.get_cluster_overview()
        cache.set("k8s_overview", cached, ttl=3)
    return cached

@app.get("/api/pods", tags=["K8s Data"])
def get_pods(namespace: str = None):
    return k8s.get_pods(namespace)

@app.get("/api/deployments", tags=["K8s Data"])
def get_deployments(namespace: str = None):
    return k8s.get_deployments(namespace)

@app.get("/api/services", tags=["K8s Data"])
def get_services(namespace: str = None):
    return k8s.get_services(namespace)

@app.get("/api/namespaces", tags=["K8s Data"])
def get_namespaces():
    return k8s.get_namespaces()

@app.get("/api/logs/{namespace}/{pod_name}", tags=["K8s Data"])
def get_pod_logs(namespace: str, pod_name: str, lines: int = 100):
    return {"pod": pod_name, "namespace": namespace, "logs": k8s.get_pod_logs(pod_name, namespace, lines)}

# --- DevOps / Operational Endpoints ---
@app.get("/health", status_code=status.HTTP_200_OK, tags=["Operational"])
def health_check():
    """
    Health check endpoint for Kubernetes Liveness and Readiness probes.
    """
    return {
        "status": "healthy",
        "k8s_connected": k8s.connected,
        "redis_connected": cache.connected
    }

@app.get("/metrics", tags=["Operational"])
def get_metrics():
    """
    Prometheus-compatible metrics endpoint.
    """
    # Retrieve data
    overview = k8s.get_cluster_overview()
    pods_total = overview["pods"]["total"]
    pods_running = overview["pods"].get("Running", 0)
    pods_failed = overview["pods"].get("Failed", 0)
    nodes_total = overview["nodes"]["total"]
    nodes_ready = overview["nodes"]["ready"]
    
    metrics_payload = (
        f"# HELP infrapulse_info Info about the application\n"
        f'infrapulse_info{{name="infrapulse",version="1.0.0"}} 1\n'
        f"# HELP infrapulse_nodes_total Total number of nodes in K8s cluster\n"
        f"# TYPE infrapulse_nodes_total gauge\n"
        f"infrapulse_nodes_total {nodes_total}\n"
        f"# HELP infrapulse_nodes_ready Ready nodes in K8s cluster\n"
        f"# TYPE infrapulse_nodes_ready gauge\n"
        f"infrapulse_nodes_ready {nodes_ready}\n"
        f"# HELP infrapulse_pods_total Total pods in K8s cluster\n"
        f"# TYPE infrapulse_pods_total gauge\n"
        f"infrapulse_pods_total {pods_total}\n"
        f"# HELP infrapulse_pods_running Running pods in K8s cluster\n"
        f"# TYPE infrapulse_pods_running gauge\n"
        f"infrapulse_pods_running {pods_running}\n"
        f"# HELP infrapulse_pods_failed Failed pods in K8s cluster\n"
        f"# TYPE infrapulse_pods_failed gauge\n"
        f"infrapulse_pods_failed {pods_failed}\n"
    )
    return metrics_payload

# --- WebSockets ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Send initial state immediately
    try:
        state = k8s.get_full_state()
        await websocket.send_json({
            "type": "initial_state",
            "data": state
        })
        while True:
            # Keep connection alive, listen for messages if client sends any
            data = await websocket.receive_text()
            # Handle client-side commands if any
            logger.info("Received from client: %s", data)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error("WS connection exception: %s", e)
        manager.disconnect(websocket)
