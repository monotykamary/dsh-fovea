package server

import "os"

func DatabaseURL() string {
	return os.Getenv("DATABASE_URL")
}
