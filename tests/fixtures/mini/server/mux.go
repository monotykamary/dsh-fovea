package server

import "net/http"

func registerSysRoutes() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthCheck)
	mux.HandleFunc("POST /v2/shutdown", shutdownServer)
}

func registerApiRoutes() {
	r := chi.NewRouter()
	r.Method("GET", "/api/metrics", http.HandlerFunc(metricsPage))
}

func healthCheck(w http.ResponseWriter, r *http.Request)  {}
func shutdownServer(w http.ResponseWriter, r *http.Request) {}
func metricsPage(w http.ResponseWriter, r *http.Request)    {}
