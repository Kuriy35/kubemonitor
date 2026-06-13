import pytest
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert "k8s_connected" in response.json()

def test_metrics():
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "kubemonitor_info" in response.text
    assert "kubemonitor_pods_total" in response.text

def test_root_html():
    response = client.get("/")
    assert response.status_code == 200
    assert "KubeMonitor" in response.text
    assert "progress-bar-running" in response.text

def test_api_overview():
    response = client.get("/api/overview")
    assert response.status_code == 200
    assert "cluster_health" in response.json()
    assert "pods" in response.json()

def test_api_pods():
    response = client.get("/api/pods")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
    if len(response.json()) > 0:
        assert "name" in response.json()[0]
        assert "status" in response.json()[0]

def test_api_deployments():
    response = client.get("/api/deployments")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
    if len(response.json()) > 0:
        assert "name" in response.json()[0]
        assert "replicas" in response.json()[0]

def test_api_services():
    response = client.get("/api/services")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
    if len(response.json()) > 0:
        assert "name" in response.json()[0]
        assert "cluster_ip" in response.json()[0]

def test_api_events():
    response = client.get("/api/events")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
    if len(response.json()) > 0:
        assert "type" in response.json()[0]
        assert "reason" in response.json()[0]
        assert "object" in response.json()[0]
        assert "message" in response.json()[0]
        assert "time" in response.json()[0]

def test_api_status():
    response = client.get("/status")
    assert response.status_code in [200, 503]
    data = response.json()
    assert "status" in data
    assert "k8s_connected" in data


