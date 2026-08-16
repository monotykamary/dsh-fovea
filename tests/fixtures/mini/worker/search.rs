// Rust worker sharing the user-route literal with the Go server and the TS
// client: walks the /api/users join across a third language.

pub struct UserSearch {
    endpoint: String,
}

impl UserSearch {
    pub fn new() -> Self {
        Self { endpoint: String::from("/api/users/{id}") }
    }

    pub fn fetch(&self, id: u64) -> String {
        format!("{}/{}", self.endpoint.replace("{id}", ""), id)
    }
}
