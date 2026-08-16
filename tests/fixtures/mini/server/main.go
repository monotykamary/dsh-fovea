package main

import (
	"os"

	"github.com/acme/app/server"
)

func main() {
	db := os.Getenv("DATABASE_URL")
	r := NewRouter(db)
	r.GET("/api/users/:id", server.GetUserHandler)
	r.POST("/api/users", server.CreateUserHandler)
	r.Run(":8080")
}

func NewRouter(db string) *Router { return &Router{db: db} }

type Router struct{ db string }

func (r *Router) GET(path string, h interface{}) {}
func (r *Router) POST(path string, h interface{}) {}
func (r *Router) Run(addr string) {}
