# InfraPulse - Kubernetes Real-time Monitor

**InfraPulse** — це легкий веб-дашборд для моніторингу стану Kubernetes-кластера в реальному часі. Проект розроблений та підготовлений до автоматизованого розгортання в рамках проходження виробничої практики.

## 🏗️ Архітектура
* **Backend**: Python 3.11, FastAPI (асинхронні WebSockets для live-оновлення даних).
* **Cache**: Redis для кешування результатів запитів до Kubernetes API та уникнення API rate-limits.
* **Frontend**: Single Page Application на базі Vanilla HTML5/CSS3 (Dark Mode + Glassmorphism) та Chart.js.
* **IaC**: Terraform для автоматичного розгортання ArgoCD та налаштувань Minikube.
* **GitOps**: ArgoCD для автоматичної синхронізації стану контейнерів з описом у Helm Chart.

## 🚀 Швидкий запуск
Для локального запуску бекенду в режимі розробки:
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
Після запуску відкрийте http://localhost:8000. Якщо кластер Kubernetes недоступний, додаток автоматично перейде в інтерактивний демонстраційний режим (**Demo Mode**).
