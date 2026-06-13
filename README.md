# KubeMonitor - Kubernetes Real-time Monitor

**KubeMonitor** is a lightweight web dashboard for real-time monitoring of Kubernetes cluster status. The project is designed and prepared for automated deployment.

## 🏗️ Architecture
* **Backend**: Python 3.11, FastAPI (asynchronous WebSockets for live data updates).
* **Cache**: Redis for caching Kubernetes API requests to avoid API rate limits.
* **Frontend**: Single Page Application based on Vanilla HTML5/CSS3 (Dark Mode + Glassmorphism) and Chart.js.
* **IaC**: Terraform for automatic deployment of ArgoCD and Minikube configurations.
* **GitOps**: ArgoCD for automatic synchronization of container state with the Helm Chart description.

## 🚀 Quick Start
To run the backend locally in development mode:
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
After starting, open http://localhost:8000. If the Kubernetes cluster is unavailable, the application will automatically switch to the interactive demonstration mode (**Demo Mode**).
