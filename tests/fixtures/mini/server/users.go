package server

import "fmt"

func GetUserHandler(id string) string {
	return LoadUser(id)
}

func CreateUserHandler(name string) error {
	return SaveUser(name)
}

func LoadUser(id string) string {
	fmt.Println("/api/users/" + id)
	return id
}

func SaveUser(name string) error { return nil }
